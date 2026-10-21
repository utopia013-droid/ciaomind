"""Read-only cost/quality planner. Never calls providers or reserves real quotas."""
import argparse
from datetime import datetime, timezone, timedelta
import json
import math
from pathlib import Path


def timestamp(value):
    parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if parsed.tzinfo is None:
        raise ValueError('Timestamps must include timezone')
    return parsed


def nonnegative(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
        raise ValueError('Expected finite nonnegative number')
    return value


def wilson_lower(passed, total):
    if not total:
        return 0.0
    z = 1.96
    proportion = passed / total
    return (proportion + z*z/(2*total) - z*math.sqrt(proportion*(1-proportion)/total + z*z/(4*total*total))) / (1 + z*z/total)


def plan(policy, task, providers, observations, budget, current_time=None):
    """Return an explainable recommendation, never an execution authorization.

    Inputs are locally reviewed configuration/telemetry, not model-generated commands.
    Caller must provide budget headroom net of all pending reservations.
    """
    current_time = current_time or datetime.now(timezone.utc)
    for key in ('minimum_evaluations', 'evaluation_window_days', 'max_attempts_per_stage', 'max_attempts_per_workflow'):
        if type(policy[key]) is not int or policy[key] < 1:
            raise ValueError('Positive integer policy limit required')
    if not 0 <= nonnegative(policy['minimum_quality_lower_bound']) <= 1:
        raise ValueError('Quality threshold must be within [0,1]')
    for key in ('attempts_so_far', 'workflow_attempts_so_far', 'input_tokens', 'max_output_tokens'):
        if type(task[key]) is not int or task[key] < 0:
            raise ValueError('Nonnegative integer task count required')
    if len({p['id'] for p in providers}) != len(providers):
        raise ValueError('Duplicate provider ID')
    if task['mode'] not in ('simulation', 'live'):
        raise ValueError('Task mode must be simulation or live')
    if task['data_class'] not in ('public', 'private', 'restricted'):
        raise ValueError('Unknown data class')
    input_tokens = nonnegative(task['input_tokens'])
    output_tokens = nonnegative(task['max_output_tokens'])
    headroom = min(nonnegative(budget['daily_remaining_usd']), nonnegative(budget['monthly_remaining_usd']), nonnegative(policy['per_attempt_usd']))
    if task['attempts_so_far'] >= policy['max_attempts_per_stage'] or task['workflow_attempts_so_far'] >= policy['max_attempts_per_workflow']:
        return {'status': 'paused', 'reason': 'attempt_limit', 'execution_enabled': False}
    rejected, eligible = {}, []
    for provider in providers:
        pid = provider['id']
        reasons = []
        if provider.get('enabled') is not True or provider.get('authenticated_e2e') is not True:
            reasons.append('not_connected_and_verified')
        if provider.get('terms_valid_until') is None or timestamp(provider['terms_valid_until']) <= current_time:
            reasons.append('terms_or_price_review_expired')
        if task['data_class'] not in provider.get('allowed_data_classes', []):
            reasons.append('data_not_authorized')
        if task['data_class'] == 'restricted' and provider.get('local') is not True:
            reasons.append('restricted_requires_local')
        if provider.get('local') is not True and provider.get('no_training_confirmed') is not True and task['data_class'] != 'public':
            reasons.append('private_data_terms_not_confirmed')
        if task['stage'] not in provider.get('stages', []) or task['language'] not in provider.get('languages', []):
            reasons.append('capability_not_verified')
        if input_tokens + output_tokens > nonnegative(provider['context_tokens']):
            reasons.append('context_limit')
        if provider.get('cooldown_until') and timestamp(provider['cooldown_until']) > current_time:
            reasons.append('cooldown')
        # Quotas are provider-specific native units: requests, tokens, neurons, etc.
        # Never convert one vendor's free tokens into another vendor's balance.
        if provider.get('quota_valid_until') is None or timestamp(provider['quota_valid_until']) <= current_time:
            reasons.append('quota_unknown_or_expired')
        remaining = provider.get('remaining_units')
        required = task.get('required_units', {}).get(pid)
        if remaining is None or required is None:
            reasons.append('quota_estimate_missing')
        elif nonnegative(required) > nonnegative(remaining):
            reasons.append('quota_exhausted')
        if provider.get('billing_mode') not in ('free_hard_stop', 'paid_bounded', 'local'):
            reasons.append('billing_mode_unverified')
        pricing = provider.get('pricing')
        upper_cost = None
        if not isinstance(pricing, dict) or any(pricing.get(key) is None for key in ('input_usd_per_million', 'output_usd_per_million', 'max_extra_usd')):
            reasons.append('cost_upper_bound_unknown')
        else:
            # Conservative uncached upper bound; include reasoning in max output.
            upper_cost = (input_tokens * nonnegative(pricing['input_usd_per_million']) + output_tokens * nonnegative(pricing['output_usd_per_million'])) / 1_000_000 + nonnegative(pricing['max_extra_usd'])
            if provider.get('billing_mode') == 'free_hard_stop' and upper_cost > 0:
                reasons.append('free_route_has_nonzero_cost')
            if upper_cost > 0 and policy.get('paid_enabled') is not True:
                reasons.append('paid_disabled')
            if upper_cost > headroom + 1e-12:
                reasons.append('budget_limit')
        # Independent cases and measured/synthetic provenance cannot be pooled.
        dimensions = ('stage', 'language', 'prompt_version', 'task_family', 'evaluation_set', 'rubric_version', 'data_class')
        signature = (pid, provider['model_version'], *(task[k] for k in dimensions))
        cutoff = current_time - timedelta(days=policy['evaluation_window_days'])
        origin = 'synthetic' if task['mode'] == 'simulation' else 'measured'
        attempts = {}
        for observation in observations:
            if observation.get('sample_origin') != origin:
                continue
            observed_signature = (observation['provider_id'], observation['model_version'], *(observation[k] for k in dimensions))
            if observed_signature != signature or not cutoff <= timestamp(observation['at']) <= current_time:
                continue
            if not isinstance(observation.get('case_id'), str) or not observation['case_id'] or not isinstance(observation.get('attempt_id'), str) or not observation['attempt_id']:
                raise ValueError('Independent case and attempt IDs required')
            if type(observation.get('human_pass')) is not bool or type(observation.get('checks_pass')) is not bool:
                raise ValueError('Quality labels must be explicit human/check booleans')
            aid = observation['attempt_id']
            if aid in attempts and attempts[aid] != observation:
                raise ValueError('Conflicting telemetry for attempt')
            attempts[aid] = observation
        records = list(attempts.values())
        cases = {}
        for observation in sorted(records, key=lambda o: (timestamp(o['at']), o['attempt_id'])):
            cases[observation['case_id']] = observation
        successes = sum(o['human_pass'] and o['checks_pass'] for o in cases.values())
        lower = wilson_lower(successes, len(cases))
        if not successes or len(cases) < policy['minimum_evaluations'] or lower < policy['minimum_quality_lower_bound']:
            reasons.append('needs_benchmark_or_quality_insufficient')
        if reasons:
            rejected[pid] = reasons
            continue
        # All attempts, including failures, contribute cost and review time.
        historic_cash = sum(nonnegative(o['actual_usd']) for o in records) / successes
        review_minutes = sum(nonnegative(o['human_minutes']) for o in records) / successes
        score = upper_cost / max(lower, 1e-9)
        value_of_time = policy.get('human_usd_per_hour')
        if value_of_time is not None:
            score += review_minutes * nonnegative(value_of_time) / 60
        eligible.append({'provider_id': pid, 'estimated_cost_upper_usd': upper_cost,
                         'historic_usd_per_accepted': historic_cash,
                         'historic_human_minutes_per_accepted': review_minutes,
                         'quality_lower_bound': lower, 'samples': len(cases), 'attempts': len(records), 'score': score})
    eligible.sort(key=lambda row: (row['score'], row['historic_human_minutes_per_accepted'], row['provider_id']))
    return {'status': 'recommended' if eligible else 'queued', 'execution_enabled': False,
            'recommended': eligible[0] if eligible else None, 'alternatives': eligible[1:],
            'excluded': rejected, 'notice': 'Read-only plan. No model calls, real reservations, spend, or worldview changes.'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('input', help='Private JSON containing policy/task/providers/observations/budget')
    args = parser.parse_args()
    try:
        data = json.loads(Path(args.input).read_text(encoding='utf-8'))
        print(json.dumps(plan(**data), ensure_ascii=False, indent=2))
    except (ValueError, KeyError, TypeError, OSError, ZeroDivisionError):
        parser.exit(1, 'Invalid local routing configuration or telemetry; no execution performed.\n')


if __name__ == '__main__':
    main()
