#!/usr/bin/env node
// Local probe only. This script never logs in, changes credentials, or writes a desktop ack.
import { createHash, randomUUID } from 'node:crypto';
import { accessSync, closeSync, constants, existsSync, ftruncateSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, statSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const MODULE_NAMES = Object.freeze(['codex.mjs', 'protocol.mjs', 'process.mjs', 'demo.mjs', 'demo-worker.mjs']);
let pin;
try {
  const value = JSON.parse(readFileSync(new URL('./executed-modules.json', import.meta.url), 'utf8'));
  if (!/^[a-f0-9]{40}$/.test(value.source_commit) || !value.files || Object.keys(value.files).length !== MODULE_NAMES.length || MODULE_NAMES.some(name => !/^[a-f0-9]{64}$/.test(value.files[name]))) throw new Error('Invalid source pin');
  pin = value;
} catch { pin = null; }
const SOURCE_COMMIT = pin?.source_commit ?? null;
const SAFE_CODES = new Set(['BINARY_MISSING', 'WORKDIR_REQUIRED', 'WORKDIR_MISSING', 'AUTH_REQUIRED', 'AUTH_MODE_NOT_ALLOWED', 'AUTH_UNVERIFIED', 'WORKER_DISABLED', 'CONFIG_REVIEW_REQUIRED', 'ABORTED', 'TIMEOUT', 'OUTPUT_LIMIT', 'WORKER_FAILED', 'INVALID_RESULT', 'RESULT_IDENTITY_MISMATCH', 'PRODUCER_MISMATCH', 'PROCESS_ERROR', 'SOURCE_MISMATCH', 'NODE_VERSION_REQUIRED', 'OUTPUT_MUST_BE_OUTSIDE_SOURCE', 'OUTPUT_EXISTS', 'NATIVE_BINARY_REQUIRED', 'API_KEY_ENV_NOT_ALLOWED', 'CUSTOM_ROUTE_REVIEW_REQUIRED', 'TASK_OUTPUT_MISMATCH', 'REVIEW_REJECTED']);
const SAFE_PROVIDER_CODES = new Set(['refresh_token_invalidated', 'refresh_token_expired', 'refresh_token_reused', 'invalid_api_key', 'invalid_token', 'token_expired', 'unauthorized', 'authentication_error', 'account_deactivated', 'insufficient_quota', 'rate_limit_exceeded', 'model_not_found', 'invalid_request_error', 'unsupported_value', 'unclassified']);
const SAFE_HTTP = new Set([400, 401, 403, 404, 408, 409, 422, 429, 500, 502, 503, 504]);

function localError(code) { return Object.assign(new Error(code), { code, notStarted: true }); }
function safeError(error) {
  const result = { code: SAFE_CODES.has(error?.code) ? error.code : 'LOCAL_CHECK_FAILED', retryable: false, not_started: error?.notStarted === true };
  if (error?.diagnostic) {
    const d = error.diagnostic;
    result.diagnostic = { provider: d.provider === 'codex' ? 'codex' : 'unverified', http_status: SAFE_HTTP.has(d.http_status) ? d.http_status : null, error_code: SAFE_PROVIDER_CODES.has(d.error_code) ? d.error_code : 'unclassified' };
    if (d.auth_failure_reason === 'account_identity_mismatch') result.diagnostic.auth_failure_reason = d.auth_failure_reason;
    if (d.recovery_action === 'sign_in_again') result.diagnostic.recovery_action = d.recovery_action;
  }
  return result;
}
function options(argv) {
  const out = { synthetic: false };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--help') return { help: true };
    if (key === '--synthetic-smoke') { out.synthetic = true; continue; }
    if (!['--source', '--binary', '--output'].includes(key) || !argv[i + 1] || argv[i + 1].startsWith('--')) throw localError('LOCAL_CHECK_FAILED');
    const name = key.slice(2);
    if (out[name]) throw localError('LOCAL_CHECK_FAILED');
    out[name] = argv[++i];
  }
  if (!out.source || !out.output || (!out.synthetic && !out.binary)) throw localError('LOCAL_CHECK_FAILED');
  return out;
}
function inside(root, path) {
  const r = relative(root, path);
  return r === '' || (!r.startsWith('..' + sep) && r !== '..' && !isAbsolute(r));
}
function publish(fd, report) {
  if (fd === undefined) return;
  const data = Buffer.from(JSON.stringify(report, null, 2) + '\n');
  writeSync(fd, data, 0, data.length, 0);
  ftruncateSync(fd, data.length);
  fsyncSync(fd);
}
function summary(report) {
  return { probe_id: report.probe_id, run_id: report.run_id, mode: report.mode, status: report.status, node: report.runtime.node, platform: report.runtime.platform, executed_modules_verified: report.source_validation.executed_modules_verified, adapter_invocations: report.adapter_invocations, provider_invocations_started_or_uncertain: report.provider_invocations_started_or_uncertain, remote_vendor_authenticated: report.remote_vendor_authenticated, producer_inference_passed: report.stages.producer.inference_passed ?? false, task_acceptance_passed: report.stages.producer.acceptance_passed ?? false, review_accepted: report.stages.reviewer.acceptance_passed ?? false, same_provider: true, cross_vendor_verified: false, failure: report.failure ?? null };
}

let opts;
try { opts = options(process.argv.slice(2)); } catch (error) { console.log(JSON.stringify({ status: 'blocked', failure: safeError(error), remote_vendor_authenticated: false })); process.exit(2); }
if (opts.help) {
  console.log('Node 24+. Live: node probe.mjs --source <pinned source repo> --binary <absolute native codex executable> --output <new private JSON file>\nSynthetic only: node probe.mjs --source <pinned source repo> --output <new private JSON file> --synthetic-smoke\nAt most two adapter invocations. No login, API-key fallback, model override, or desktop acknowledgement is performed.');
  process.exit(0);
}
const report = {
  protocol: 'ciaomind.local-auth-probe.v1', probe_id: 'CODEX-DESKTOP-AUTH-20261025-001', run_id: randomUUID(), started_at: new Date().toISOString(), mode: opts.synthetic ? 'synthetic-local-no-model' : 'existing-codex-chatgpt-login', status: 'running',
  runtime: { node: process.versions.node, platform: process.platform, arch: process.arch },
  source_validation: { expected_commit: SOURCE_COMMIT, mechanism: 'sha256-of-five-executed-adapter-modules', executed_modules_verified: false, full_repository_revision_verified: false },
  adapter_invocations: 0, provider_invocations_started_or_uncertain: 0, max_adapter_invocations: 2, budget_unit: 'adapter invocations; provider-internal requests are not a hard-capped count',
  remote_vendor_authenticated: false, cross_vendor_verified: false, model_override: false, desktop_ack_generated: false,
  stages: { preflight: { status: 'not_run' }, producer: { status: 'not_run' }, reviewer: { status: 'not_run' } },
};
let fd, directory, stage = 'preflight';
const abort = new AbortController();
const cancel = () => abort.abort();
process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
try {
  if (Number(process.versions.node.split('.')[0]) < 24) throw localError('NODE_VERSION_REQUIRED');
  if (!pin) throw localError('SOURCE_MISMATCH');
  const source = realpathSync(resolve(opts.source));
  const output = resolve(opts.output);
  if (inside(source, output)) throw localError('OUTPUT_MUST_BE_OUTSIDE_SOURCE');
  mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
  const privateParent = realpathSync(dirname(output));
  if (inside(source, join(privateParent, basename(output)))) throw localError('OUTPUT_MUST_BE_OUTSIDE_SOURCE');
  try { fd = openSync(output, 'wx', 0o600); } catch (error) { if (error.code === 'EEXIST') throw localError('OUTPUT_EXISTS'); throw error; }
  publish(fd, report);
  const adapters = join(source, 'apps', 'alliance-agent', 'orchestrator', 'adapters');
  for (const name of MODULE_NAMES) {
    const expected = pin.files[name];
    const actual = createHash('sha256').update(readFileSync(join(adapters, name))).digest('hex');
    if (actual !== expected) throw localError('SOURCE_MISMATCH');
  }
  report.source_validation.executed_modules_verified = true;
  directory = mkdtempSync(join(tmpdir(), 'ciaomind-desktop-auth-probe-'));
  let producer, reviewer;
  if (opts.synthetic) {
    const { createDemoWorker } = await import(pathToFileURL(join(adapters, 'demo.mjs')).href);
    producer = createDemoWorker({ id: 'demo-auth-producer' });
    reviewer = createDemoWorker({ id: 'demo-auth-reviewer' });
    report.provider = 'local-demo';
  } else {
    if (!isAbsolute(opts.binary) || /\.(cmd|bat|js|mjs)$/i.test(opts.binary) || (process.platform === 'win32' && extname(opts.binary).toLowerCase() !== '.exe')) throw localError('NATIVE_BINARY_REQUIRED');
    const binary = realpathSync(opts.binary);
    accessSync(binary, constants.X_OK);
    if (!statSync(binary).isFile()) throw localError('NATIVE_BINARY_REQUIRED');
    if (process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY) throw localError('API_KEY_ENV_NOT_ALLOWED');
    if (process.env.OPENAI_BASE_URL || process.env.OPENAI_API_BASE) throw localError('CUSTOM_ROUTE_REVIEW_REQUIRED');
    // Preserve all inherited authentication, proxy, and guard settings.
    const env = { ...process.env, CIAOMIND_ENABLE_WORKERS: '1' };
    const version = spawnSync(binary, ['--version'], { env, shell: false, encoding: 'utf8', timeout: 5000, maxBuffer: 32000, windowsHide: true });
    report.binary_version = /codex-cli\s+([0-9][A-Za-z0-9.+-]*)/.exec(version.stdout ?? '')?.[1] ?? 'unverified';
    const { createCodexWorker } = await import(pathToFileURL(join(adapters, 'codex.mjs')).href);
    const base = { enabled: true, namespaces: ['project'], binary, workdir: directory, allowApiKey: false, timeoutMs: 60000, maxOutputBytes: 256000 };
    producer = createCodexWorker({ ...base, id: 'codex-desktop-producer' }, { env });
    reviewer = createCodexWorker({ ...base, id: 'codex-desktop-reviewer' }, { env });
    report.provider = 'codex';
    const state = await producer.doctor();
    report.stages.preflight = { status: state.reason || state.auth !== 'chatgpt' ? 'blocked' : 'passed', installed: state.installed, configured: state.configured, login_metadata_auth: state.auth, inference_verified: false };
    if (state.reason || state.auth !== 'chatgpt') throw localError(state.reason ?? 'AUTH_UNVERIFIED');
  }
  report.stages.preflight.status = 'passed';
  report.worker_ids = { producer: producer.id, reviewer: reviewer.id, different_ids_same_provider: true };
  const input = { operation: 'sum', values: [8, 3, 5, 3, -2] };
  const inputHash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
  const packet = {
    protocol: 'ciaomind.goal-worker.v1', type: 'task', namespace: 'project', goal_id: report.probe_id, goal_version: 1, step_id: 'synthetic-sum', task_id: `project/${report.probe_id}/synthetic-sum`, input_sha256: inputHash, attempt_id: randomUUID(), worker: producer.id, kind: 'research', capability: opts.synthetic ? 'demo.compute' : 'reasoning', input,
    objective: 'Compute only the sum in packet.input. Do not use tools, read files, access private data, send messages, or change anything. For a Codex result, output.summary must be exactly the decimal integer string and output.artifacts must be empty.',
    acceptance: ['Independently sum the finite input numbers; the exact expected total is 17.', 'Use no tools or external sources, and claim no file artifacts.'],
    grant: { namespace: 'project', capability: opts.synthetic ? 'demo.compute' : 'reasoning' }, lease_until: Date.now() + 150000, idempotency_key: report.run_id,
  };
  async function invoke(adapter, request) {
    if (abort.signal.aborted) throw localError('ABORTED');
    if (report.adapter_invocations >= 2) throw localError('LOCAL_CHECK_FAILED');
    report.adapter_invocations++;
    publish(fd, report);
    try {
      const result = await adapter.run(request, { signal: abort.signal });
      if (!opts.synthetic) report.provider_invocations_started_or_uncertain++;
      return result;
    } catch (error) {
      if (!opts.synthetic && error.notStarted !== true) report.provider_invocations_started_or_uncertain++;
      throw error;
    }
  }
  stage = 'producer'; report.stages.producer.status = 'running';
  const produced = await invoke(producer, packet);
  report.producer_result = produced;
  report.stages.producer.inference_passed = !opts.synthetic;
  if (!opts.synthetic) report.remote_vendor_authenticated = true;
  const correct = opts.synthetic ? produced.output?.sum === 17 : produced.output?.summary?.trim() === '17' && Array.isArray(produced.output?.artifacts) && produced.output.artifacts.length === 0;
  if (!correct) throw Object.assign(localError('TASK_OUTPUT_MISMATCH'), { notStarted: false });
  report.stages.producer = { status: 'passed', inference_passed: !opts.synthetic, acceptance_passed: true };
  publish(fd, report);
  stage = 'reviewer'; report.stages.reviewer.status = 'running';
  const reviewPacket = { ...packet, type: 'review', worker: reviewer.id, attempt_id: randomUUID(), capability: 'review', grant: { namespace: 'project', capability: 'review' }, result: produced, objective: 'Independently recompute the sum in packet.input. Accept only if the producer reports the correct sum and no nonexistent artifacts. Do not use tools or read files.' };
  const reviewed = await invoke(reviewer, reviewPacket);
  report.reviewer_result = reviewed;
  report.stages.reviewer.inference_passed = !opts.synthetic;
  if (reviewed.decision !== 'accept') throw Object.assign(localError('REVIEW_REJECTED'), { notStarted: false });
  report.stages.reviewer = { status: 'passed', inference_passed: !opts.synthetic, acceptance_passed: true };
  report.status = 'passed';
} catch (error) {
  report.status = ['TASK_OUTPUT_MISMATCH', 'REVIEW_REJECTED'].includes(error?.code) ? 'failed' : 'blocked';
  report.stages[stage].status = report.status;
  report.failure = safeError(error);
} finally {
  report.finished_at = new Date().toISOString();
  try { publish(fd, report); } catch { report.status = 'blocked'; report.failure = { code: 'OUTPUT_WRITE_FAILED', retryable: false }; }
  if (fd !== undefined) closeSync(fd);
  if (directory) {
    try { rmSync(directory, { recursive: true, force: true }); }
    catch { report.temporary_directory_cleanup = 'incomplete'; }
  }
  process.off('SIGINT', cancel); process.off('SIGTERM', cancel);
  console.log(JSON.stringify(summary(report)));
  process.exitCode = report.status === 'passed' ? 0 : 2;
}
