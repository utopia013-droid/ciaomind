from copy import deepcopy
from datetime import datetime, timezone, timedelta
import unittest
from knowledge.routing import plan


class RoutingTests(unittest.TestCase):
    def setUp(self):
        self.now = datetime(2026, 10, 21, tzinfo=timezone.utc)
        future = (self.now + timedelta(days=1)).isoformat()
        self.policy = {'paid_enabled': False, 'per_attempt_usd': .05, 'max_attempts_per_stage': 2, 'max_attempts_per_workflow': 8, 'minimum_evaluations': 20, 'minimum_quality_lower_bound': .8, 'evaluation_window_days': 30, 'human_usd_per_hour': None}
        self.provider = {'id': 'fixture-free', 'enabled': True, 'authenticated_e2e': True, 'terms_valid_until': future, 'allowed_data_classes': ['public'], 'local': False, 'no_training_confirmed': False, 'stages': ['extract'], 'languages': ['zh'], 'context_tokens': 10000, 'quota_valid_until': future, 'remaining_units': 100, 'billing_mode': 'free_hard_stop', 'model_version': 'fixture-v1', 'pricing': {'input_usd_per_million': 0, 'output_usd_per_million': 0, 'max_extra_usd': 0}}
        self.task = {'data_class': 'public', 'input_tokens': 1000, 'max_output_tokens': 500, 'attempts_so_far': 0, 'workflow_attempts_so_far': 0, 'required_units': {'fixture-free': 1}, 'stage': 'extract', 'language': 'zh', 'prompt_version': 'p1', 'mode': 'simulation', 'task_family': 'fixture', 'evaluation_set': 'fixture-set-v1', 'rubric_version': 'rubric-v1'}
        self.observations = [{'provider_id': 'fixture-free', 'model_version': 'fixture-v1', 'stage': 'extract', 'language': 'zh', 'prompt_version': 'p1', 'at': self.now.isoformat(), 'human_pass': True, 'checks_pass': True, 'actual_usd': 0, 'human_minutes': 1, 'sample_origin': 'synthetic', 'case_id': str(i), 'attempt_id': str(i), 'task_family': 'fixture', 'evaluation_set': 'fixture-set-v1', 'rubric_version': 'rubric-v1', 'data_class': 'public'} for i in range(20)]
        self.budget = {'daily_remaining_usd': 0, 'monthly_remaining_usd': 0}

    def run_plan(self, **kwargs):
        data = dict(policy=self.policy, task=self.task, providers=[self.provider], observations=self.observations, budget=self.budget, current_time=self.now)
        data.update(kwargs)
        return plan(**data)

    def test_verified_free_route_and_no_execution(self):
        result = self.run_plan()
        self.assertEqual(result['status'], 'recommended')
        self.assertFalse(result['execution_enabled'])
        self.assertEqual(result['recommended']['estimated_cost_upper_usd'], 0)

    def test_private_restricted_and_unknown_cannot_use_unapproved_free(self):
        for label in ('private', 'restricted'):
            self.task['data_class'] = label
            self.assertEqual(self.run_plan()['status'], 'queued')
        self.task['data_class'] = 'unknown'
        with self.assertRaises(ValueError): self.run_plan()

    def test_paid_requires_opt_in_and_sufficient_headroom(self):
        self.provider['billing_mode'] = 'paid_bounded'
        self.provider['pricing']['input_usd_per_million'] = 1
        self.assertIn('paid_disabled', self.run_plan()['excluded']['fixture-free'])
        self.policy['paid_enabled'] = True
        self.assertIn('budget_limit', self.run_plan()['excluded']['fixture-free'])
        self.budget = {'daily_remaining_usd': .01, 'monthly_remaining_usd': .01}
        self.assertEqual(self.run_plan()['status'], 'recommended')

    def test_unknown_expired_or_empty_quota_does_not_trigger_paid_fallback(self):
        for remaining in (None, 0):
            self.provider['remaining_units'] = remaining
            self.assertEqual(self.run_plan()['status'], 'queued')
        self.provider['remaining_units'] = 10
        self.provider['quota_valid_until'] = self.now.isoformat()
        self.assertEqual(self.run_plan()['status'], 'queued')

    def test_failed_or_changed_model_does_not_inherit_quality(self):
        self.provider['model_version'] = 'fixture-v2'
        self.assertEqual(self.run_plan()['status'], 'queued')
        self.provider['model_version'] = 'fixture-v1'
        for row in self.observations: row['checks_pass'] = False
        self.assertEqual(self.run_plan()['status'], 'queued')

    def test_retries_bounded_and_unknown_prices_blocked(self):
        self.task['attempts_so_far'] = 2
        self.assertEqual(self.run_plan()['status'], 'paused')
        self.task['attempts_so_far'] = 0
        self.provider['pricing']['max_extra_usd'] = None
        self.assertEqual(self.run_plan()['status'], 'queued')

    def test_learning_moves_route_only_with_matching_human_results(self):
        other = deepcopy(self.provider)
        other['id'] = 'fixture-other'
        self.task['required_units']['fixture-other'] = 1
        other_records = [dict(row, provider_id='fixture-other', human_minutes=.1) for row in self.observations]
        self.assertEqual(self.run_plan(providers=[self.provider, other], observations=self.observations+other_records)['recommended']['provider_id'], 'fixture-other')
        for row in other_records: row['human_pass'] = False
        self.assertEqual(self.run_plan(providers=[self.provider, other], observations=self.observations+other_records)['recommended']['provider_id'], 'fixture-free')

    def test_repeated_cases_and_synthetic_records_cannot_validate_live_route(self):
        for record in self.observations:
            record['case_id'] = 'one-repeated-case'
        self.assertEqual(self.run_plan()['status'], 'queued')
        self.task['mode'] = 'live'
        self.assertEqual(self.run_plan()['status'], 'queued')

    def test_data_class_and_task_family_are_separate_benchmarks(self):
        self.provider['allowed_data_classes'] = ['public', 'private']
        self.provider['no_training_confirmed'] = True
        self.task['data_class'] = 'private'
        self.assertEqual(self.run_plan()['status'], 'queued')
        self.task['data_class'] = 'public'
        self.task['task_family'] = 'another-task'
        self.assertEqual(self.run_plan()['status'], 'queued')

    def test_duplicate_attempts_do_not_inflate_cost_or_sample_count(self):
        result = self.run_plan(observations=self.observations + self.observations)
        self.assertEqual(result['recommended']['samples'], 20)
        self.assertEqual(result['recommended']['attempts'], 20)

    def test_no_mutation_and_nonfinite_costs_fail_closed(self):
        before = deepcopy(self.provider)
        self.run_plan()
        self.assertEqual(self.provider, before)
        self.provider['pricing']['input_usd_per_million'] = float('nan')
        with self.assertRaises(ValueError): self.run_plan()


if __name__ == '__main__': unittest.main()
