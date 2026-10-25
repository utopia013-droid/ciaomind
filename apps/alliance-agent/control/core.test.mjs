import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { ControlPlane, canonicalJSON, MAX_INPUT_BYTES, MAX_PACKET_BYTES } from './core.mjs';

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL('./cli.mjs', import.meta.url));
const task = { task_id: 'CIAO-SYNTHETIC-001', kind: 'research', input: { goal: 'Sum synthetic numbers', numbers: [3, 5, 8] } };

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ciaomind-core-test-'));
  const dbPath = join(dir, 'tasks.sqlite');
  const plane = new ControlPlane({ dbPath });
  t.after(() => { plane.close(); rmSync(dir, { recursive: true, force: true }); });
  return { plane, dbPath, dir };
}

function result(packet, extras = {}) {
  return {
    task_id: packet.task_id, input_version: packet.input_version, input_sha256: packet.input_sha256,
    attempt_id: packet.attempt_id, producer: packet.worker,
    output: { total: 16 }, evidence: ['Synthetic numbers independently summed as 3 + 5 + 8 = 16'], ...extras,
  };
}

const code = expected => error => error.code === expected;

test('canonical input is order-independent and task IDs are immutable', t => {
  const { plane } = fixture(t);
  const created = plane.createTask(task);
  const replayed = plane.createTask({ ...task, input: { numbers: [3, 5, 8], goal: 'Sum synthetic numbers' } });
  assert.equal(created.input_sha256, replayed.input_sha256);
  assert.equal(plane.events(task.task_id).length, 1);
  assert.throws(() => plane.createTask({ ...task, input: { goal: 'Changed' } }), code('INPUT_CONFLICT'));
  assert.throws(() => plane.createTask({ ...task, kind: 'code' }), code('INPUT_CONFLICT'));
  assert.throws(() => plane.createTask({ ...task, input_version: 2 }), code('INVALID_INPUT'));
  assert.throws(() => canonicalJSON({ value: undefined }), code('INVALID_INPUT'));
  assert.throws(() => canonicalJSON([Infinity]), code('INVALID_INPUT'));
  assert.throws(() => canonicalJSON(new Date()), code('INVALID_INPUT'));
});

test('accessor input is rejected without invoking object or array getters or toJSON', t => {
  const { plane } = fixture(t);
  let calls = 0;
  const input = { get value() { return ++calls; } };
  assert.throws(() => plane.createTask({ ...task, input }), code('INVALID_INPUT'));
  const array = [];
  Object.defineProperty(array, '0', { enumerable: true, get() { return ++calls; } });
  assert.throws(() => plane.createTask({ ...task, input: { array } }), code('INVALID_INPUT'));
  const hiddenAccessor = Object.defineProperty({}, 'hidden', { get() { return ++calls; } });
  assert.throws(() => canonicalJSON(hiddenAccessor), code('INVALID_INPUT'));
  assert.throws(() => canonicalJSON({ toJSON() { calls++; return {}; } }), code('INVALID_INPUT'));
  assert.equal(calls, 0);
  assert.deepEqual(plane.listTasks(), []);
});

test('saved input, dispatch input and input fingerprint use the same canonical snapshot', t => {
  const { plane } = fixture(t);
  const input = { z: [3, 5, 8], a: { label: 'snapshot' } };
  const original = structuredClone(input);
  const created = plane.createTask({ ...task, input });
  input.z.push(100);
  input.a.label = 'mutated after creation';
  const packet = plane.dispatch(task.task_id);
  const expectedSHA = createHash('sha256').update(canonicalJSON({ input_version: 1, kind: task.kind, input: original })).digest('hex');
  assert.deepEqual(created.input, original);
  assert.deepEqual(packet.input, original);
  assert.equal(created.input_sha256, expectedSHA);
  assert.equal(packet.input_sha256, expectedSHA);
});

test('maximum accepted input still dispatches with its full envelope; oversized input is rejected before storage', t => {
  const { plane } = fixture(t);
  const input = 'x'.repeat(MAX_INPUT_BYTES - 2); // Two encoded bytes are JSON string quotes.
  const created = plane.createTask({ ...task, input });
  assert.equal(Buffer.byteLength(canonicalJSON(created.input)), MAX_INPUT_BYTES);
  const packet = plane.dispatch(task.task_id);
  assert.equal(packet.input, input);
  const packetSize = Buffer.byteLength(canonicalJSON(packet));
  assert.ok(packetSize > MAX_INPUT_BYTES);
  assert.ok(packetSize <= MAX_PACKET_BYTES);
  assert.throws(() => plane.createTask({ ...task, task_id: 'TOO-LARGE', input: 'x'.repeat(999_980) }), code('INVALID_INPUT'));
  assert.throws(() => plane.getTask('TOO-LARGE'), code('NOT_FOUND'));
  assert.equal(plane.listTasks().length, 1);
});

test('dispatch is durable across connections and repeated handoffs share one attempt', t => {
  const { plane, dbPath } = fixture(t);
  plane.createTask(task);
  const packet = plane.dispatch(task.task_id);
  assert.equal(statSync(dbPath).mode & 0o777, 0o600);
  const second = new ControlPlane({ dbPath });
  try {
    assert.deepEqual(second.dispatch(task.task_id), packet);
    assert.equal(second.events(task.task_id).filter(event => event.type === 'dispatched').length, 1);
    assert.equal(second.getTask(task.task_id).status, 'dispatched');
  } finally { second.close(); }
  assert.equal(packet.execution, 'manual-file-handoff');
  assert.equal(packet.worker_authenticated, false);
});

test('simultaneous CLI processes cannot dispatch two attempts', async t => {
  const { plane, dbPath } = fixture(t);
  plane.createTask(task);
  const children = await Promise.all(Array.from({ length: 4 }, () => execFileAsync(process.execPath, [cliPath, '--db', dbPath, 'dispatch', task.task_id])));
  const packets = children.map(child => JSON.parse(child.stdout));
  assert.equal(new Set(packets.map(packet => packet.attempt_id)).size, 1);
  assert.equal(plane.events(task.task_id).filter(event => event.type === 'dispatched').length, 1);
});

test('bad fingerprints, wrong producer and old attempts leave state unchanged', t => {
  const { plane } = fixture(t);
  plane.createTask(task);
  const first = plane.dispatch(task.task_id);
  assert.throws(() => plane.submitResult(result(first, { input_sha256: '0'.repeat(64) })), code('INPUT_MISMATCH'));
  assert.throws(() => plane.submitResult(result(first, { input_version: 9 })), code('INPUT_MISMATCH'));
  assert.throws(() => plane.submitResult(result(first, { producer: 'someone-else' })), code('PRODUCER_MISMATCH'));
  plane.retryTask(task.task_id, 'Operator confirmed old attempt failed');
  const current = plane.dispatch(task.task_id);
  assert.notEqual(first.attempt_id, current.attempt_id);
  assert.throws(() => plane.submitResult(result(first)), code('STALE_ATTEMPT'));
  assert.equal(plane.getTask(task.task_id).status, 'dispatched');
});

test('only matching results reach review; self review and stale review are rejected', t => {
  const { plane } = fixture(t);
  plane.createTask(task);
  const packet = plane.dispatch(task.task_id);
  const submitted = plane.submitResult(result(packet));
  assert.equal(submitted.status, 'review');
  assert.throws(() => plane.reviewTask({ task_id: task.task_id, attempt_id: packet.attempt_id, reviewer: packet.worker, decision: 'accept', evidence: 'I wrote it' }), code('SELF_REVIEW'));
  assert.throws(() => plane.reviewTask({ task_id: task.task_id, attempt_id: packet.attempt_id, reviewer: 'Manual', decision: 'accept', evidence: 'Case variant' }), code('INVALID_INPUT'));
  assert.throws(() => plane.reviewTask({ task_id: task.task_id, attempt_id: 'old', reviewer: 'muse', decision: 'accept', evidence: 'checked' }), code('STALE_ATTEMPT'));
  const done = plane.reviewTask({ task_id: task.task_id, attempt_id: packet.attempt_id, reviewer: 'muse', decision: 'accept', evidence: 'Independent operator recomputed the synthetic total as 16' });
  assert.equal(done.status, 'done');
  const count = plane.events(task.task_id).length;
  assert.equal(plane.submitResult(result(packet)).status, 'done');
  assert.equal(plane.events(task.task_id).length, count);
  assert.throws(() => plane.submitResult(result(packet, { output: { total: 17 } })), code('RESULT_CONFLICT'));
});

test('pause blocks new handoffs and results; resume preserves current attempt', t => {
  const { plane } = fixture(t);
  plane.createTask(task);
  plane.pauseTask(task.task_id);
  assert.throws(() => plane.dispatch(task.task_id), code('INVALID_STATE'));
  plane.resumeTask(task.task_id);
  const packet = plane.dispatch(task.task_id);
  plane.pauseTask(task.task_id);
  assert.throws(() => plane.submitResult(result(packet)), code('INVALID_STATE'));
  plane.resumeTask(task.task_id);
  assert.deepEqual(plane.dispatch(task.task_id), packet);
  assert.equal(plane.submitResult(result(packet)).status, 'review');
});

test('rejected results retain audit history and require explicit retry', t => {
  const { plane } = fixture(t);
  plane.createTask(task);
  const first = plane.dispatch(task.task_id);
  plane.submitResult(result(first));
  const rejected = plane.reviewTask({ task_id: task.task_id, attempt_id: first.attempt_id, reviewer: 'muse', decision: 'reject', evidence: 'Synthetic evidence requires correction' });
  assert.equal(rejected.status, 'blocked');
  assert.throws(() => plane.dispatch(task.task_id), code('INVALID_STATE'));
  plane.retryTask(task.task_id, 'Request corrected evidence');
  const next = plane.dispatch(task.task_id);
  assert.notEqual(next.attempt_id, first.attempt_id);
  assert.equal(plane.events(task.task_id).filter(event => event.type === 'reviewed').length, 1);
});

test('sensitive routing cannot be unblocked through generic retry or resume', t => {
  const { plane } = fixture(t);
  const sensitive = plane.createTask({ ...task, kind: 'sensitive' });
  assert.equal(sensitive.worker, 'human');
  assert.equal(sensitive.status, 'blocked');
  assert.throws(() => plane.dispatch(task.task_id), code('INVALID_STATE'));
  assert.throws(() => plane.retryTask(task.task_id, 'Bypass'), code('HUMAN_REQUIRED'));
  assert.throws(() => plane.resumeTask(task.task_id), code('INVALID_STATE'));
});

test('task text remains inert JSON data', t => {
  const { plane } = fixture(t);
  const input = { goal: '$(touch /tmp/never-run); rm -rf arbitrary-path', nested: { shell: '`echo not-executed`' } };
  plane.createTask({ ...task, input, kind: 'code' });
  const packet = plane.dispatch(task.task_id);
  assert.deepEqual(packet.input, input);
  assert.equal(packet.worker, 'codex');
});

test('CLI requires an explicit private database path', async () => {
  await assert.rejects(execFileAsync(process.execPath, [cliPath, 'list']), error => error.code === 1 && error.stderr.includes('--db is required'));
  const help = await execFileAsync(process.execPath, [cliPath, '--help']);
  assert.match(help.stdout, /not authenticated identities/);
});

test('malformed CLI input is rejected without creating a task', async t => {
  const { plane, dbPath, dir } = fixture(t);
  const path = join(dir, 'broken.json');
  writeFileSync(path, '{broken');
  await assert.rejects(execFileAsync(process.execPath, [cliPath, '--db', dbPath, 'create', '--file', path]), error => error.code === 1 && error.stderr.includes('CLI_ERROR'));
  assert.deepEqual(plane.listTasks(), []);
});
