import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export const ROUTES = Object.freeze({ code: 'codex', office: 'workbuddy', research: 'manual', sensitive: 'human' });
export const MAX_INPUT_BYTES = 900_000;
export const MAX_PACKET_BYTES = 1_100_000;
export const MAX_JSON_BYTES = 1_000_000;

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function text(value, name) {
  if (typeof value !== 'string' || !value.trim() || value.length > 500) fail('INVALID_INPUT', `${name} must be a nonempty string (max 500 characters)`);
  return value;
}

// Accept JSON data only; do not silently drop undefined, serialize class instances,
// coerce non-finite numbers, or invoke a user-supplied toJSON function.
export function canonicalJSON(value, depth = 0) {
  if (depth > 64) fail('INVALID_INPUT', 'JSON nesting exceeds 64 levels');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) {
    const descriptors = jsonDescriptors(value);
    const length = descriptors.length.value;
    for (const key of Object.keys(descriptors)) {
      if (key !== 'length' && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length)) fail('INVALID_INPUT', 'JSON arrays cannot have extra properties');
    }
    const items = [];
    for (let i = 0; i < length; i++) {
      const descriptor = descriptors[i];
      if (!Object.hasOwn(descriptors, i) || !descriptor.enumerable) fail('INVALID_INPUT', 'Sparse or non-enumerable array elements are not JSON');
      items.push(canonicalJSON(descriptor.value, depth + 1));
    }
    return `[${items.join(',')}]`;
  }
  if (typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    const descriptors = jsonDescriptors(value);
    return `{${Object.keys(descriptors).sort().map(key => {
      if (!descriptors[key].enumerable) fail('INVALID_INPUT', 'Non-enumerable object properties are not JSON');
      return `${JSON.stringify(key)}:${canonicalJSON(descriptors[key].value, depth + 1)}`;
    }).join(',')}}`;
  }
  fail('INVALID_INPUT', 'Expected finite, plain JSON data');
}

function jsonDescriptors(value) {
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !Object.hasOwn(descriptors[key], 'value')) fail('INVALID_INPUT', 'JSON must contain data properties only; accessors and symbols are not supported');
  }
  return descriptors;
}

function digestSerialized(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function encoded(value, maxBytes = MAX_JSON_BYTES) {
  const result = canonicalJSON(value);
  if (Buffer.byteLength(result, 'utf8') > maxBytes) fail('INVALID_INPUT', `Encoded JSON payload exceeds ${maxBytes} bytes`);
  return result;
}

function decode(row) {
  if (!row) return null;
  return {
    task_id: row.task_id,
    input_version: row.input_version,
    input_sha256: row.input_sha256,
    kind: row.kind,
    worker: row.worker,
    input: JSON.parse(row.input_json),
    status: row.status,
    attempt_id: row.attempt_id,
    result: row.result_json ? JSON.parse(row.result_json) : null,
    blocked_reason: row.blocked_reason,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** Local, trusted-operator control plane. Actor strings are audit labels, not authentication. */
export class ControlPlane {
  #db;

  constructor({ dbPath }) {
    text(dbPath, 'dbPath');
    if (dbPath !== ':memory:') mkdirSync(dirname(resolve(dbPath)), { recursive: true, mode: 0o700 });
    this.#db = new DatabaseSync(dbPath, { timeout: 5000, allowExtension: false });
    if (dbPath !== ':memory:') chmodSync(dbPath, 0o600);
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS tasks (
        task_id TEXT PRIMARY KEY,
        input_version INTEGER NOT NULL,
        input_sha256 TEXT NOT NULL,
        kind TEXT NOT NULL,
        worker TEXT NOT NULL,
        input_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('queued','dispatched','review','done','paused','blocked')),
        resume_status TEXT,
        attempt_id TEXT,
        dispatch_json TEXT,
        result_json TEXT,
        blocked_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS events (
        event_id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL REFERENCES tasks(task_id),
        type TEXT NOT NULL,
        detail_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS results (
        attempt_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(task_id),
        result_sha256 TEXT NOT NULL,
        result_json TEXT NOT NULL
      ) STRICT;
    `);
  }

  close() { this.#db.close(); }

  #transaction(fn) {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  #row(taskId) {
    text(taskId, 'task_id');
    const row = this.#db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId);
    if (!row) fail('NOT_FOUND', `Unknown task ${taskId}`);
    return row;
  }

  #event(taskId, type, detail = {}) {
    this.#db.prepare('INSERT INTO events(task_id,type,detail_json,created_at) VALUES(?,?,?,?)')
      .run(taskId, type, encoded(detail), new Date().toISOString());
  }

  getTask(taskId) { return decode(this.#row(taskId)); }

  listTasks() { return this.#db.prepare('SELECT * FROM tasks ORDER BY created_at, task_id').all().map(decode); }

  events(taskId) {
    this.#row(taskId);
    return this.#db.prepare('SELECT * FROM events WHERE task_id = ? ORDER BY event_id').all(taskId).map(row => ({
      event_id: row.event_id, task_id: row.task_id, type: row.type,
      detail: JSON.parse(row.detail_json), created_at: row.created_at,
    }));
  }

  createTask({ task_id, input_version = 1, input, kind }) {
    text(task_id, 'task_id');
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(task_id)) fail('INVALID_INPUT', 'task_id must use 1–128 ASCII letters, digits, dots, underscores or hyphens');
    if (input_version !== 1) fail('INVALID_INPUT', 'This prototype accepts immutable input_version 1; use a new task_id for changed input');
    if (!Object.hasOwn(ROUTES, kind)) fail('INVALID_INPUT', 'kind must be code, office, research or sensitive');
    const inputJSON = encoded(input, MAX_INPUT_BYTES);
    // Snapshot once, then fingerprint the exact data persisted below. Do not read
    // properties from the caller's original object a second time.
    const inputSnapshot = JSON.parse(inputJSON);
    const inputSHA = digestSerialized(canonicalJSON({ input_version, kind, input: inputSnapshot }));
    return this.#transaction(() => {
      const existing = this.#db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(task_id);
      if (existing) {
        if (existing.input_sha256 !== inputSHA) fail('INPUT_CONFLICT', 'task_id already exists with different input or kind');
        return decode(existing);
      }
      const now = new Date().toISOString();
      const status = kind === 'sensitive' ? 'blocked' : 'queued';
      const reason = kind === 'sensitive' ? 'Sensitive task requires a separate human-authorized workflow; this prototype does not execute it.' : null;
      this.#db.prepare(`INSERT INTO tasks(task_id,input_version,input_sha256,kind,worker,input_json,status,blocked_reason,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run(task_id, input_version, inputSHA, kind, ROUTES[kind], inputJSON, status, reason, now, now);
      this.#event(task_id, 'created', { input_sha256: inputSHA, worker: ROUTES[kind], status });
      return this.getTask(task_id);
    });
  }

  dispatch(taskId) {
    return this.#transaction(() => {
      const row = this.#row(taskId);
      if (row.status === 'dispatched') return JSON.parse(row.dispatch_json);
      if (row.status !== 'queued') fail('INVALID_STATE', `Cannot dispatch a ${row.status} task`);
      const packet = {
        protocol: 'ciaomind.file-worker.v1',
        task_id: row.task_id,
        input_version: row.input_version,
        input_sha256: row.input_sha256,
        attempt_id: randomUUID(),
        kind: row.kind,
        worker: row.worker,
        input: JSON.parse(row.input_json),
        execution: 'manual-file-handoff',
        worker_authenticated: false,
      };
      this.#db.prepare('UPDATE tasks SET status=?,attempt_id=?,dispatch_json=?,updated_at=? WHERE task_id=?')
        .run('dispatched', packet.attempt_id, encoded(packet, MAX_PACKET_BYTES), new Date().toISOString(), taskId);
      this.#event(taskId, 'dispatched', { attempt_id: packet.attempt_id, worker: packet.worker, execution: packet.execution });
      return packet;
    });
  }

  submitResult(result) {
    if (!result || typeof result !== 'object' || Array.isArray(result)) fail('INVALID_INPUT', 'Expected a result object');
    const { task_id, input_version, input_sha256, attempt_id, producer, output, evidence } = result;
    text(task_id, 'task_id'); text(attempt_id, 'attempt_id'); text(producer, 'producer');
    if (output === undefined) fail('INVALID_INPUT', 'Result requires output JSON');
    if (!Array.isArray(evidence) || !evidence.length || evidence.some(item => typeof item !== 'string' || !item.trim())) fail('INVALID_INPUT', 'Result requires at least one nonempty evidence string');
    const normalized = { task_id, input_version, input_sha256, attempt_id, producer, output, evidence };
    const resultJSON = encoded(normalized);
    const resultSHA = digestSerialized(resultJSON);
    return this.#transaction(() => {
      const row = this.#row(task_id);
      if (row.input_version !== input_version || row.input_sha256 !== input_sha256) fail('INPUT_MISMATCH', 'Result does not match the task input fingerprint');
      if (!row.attempt_id || row.attempt_id !== attempt_id) fail('STALE_ATTEMPT', 'Result does not match the current dispatch attempt');
      if (row.worker !== producer) fail('PRODUCER_MISMATCH', 'producer must match the dispatched worker audit label');
      const existing = this.#db.prepare('SELECT result_sha256 FROM results WHERE attempt_id=?').get(attempt_id);
      if (existing) {
        if (existing.result_sha256 !== resultSHA) fail('RESULT_CONFLICT', 'A different immutable result already exists for this attempt');
        return decode(row);
      }
      if (row.status !== 'dispatched') fail('INVALID_STATE', `Cannot submit a result for a ${row.status} task`);
      this.#db.prepare('INSERT INTO results(attempt_id,task_id,result_sha256,result_json) VALUES(?,?,?,?)')
        .run(attempt_id, task_id, resultSHA, resultJSON);
      this.#db.prepare('UPDATE tasks SET status=?,result_json=?,updated_at=? WHERE task_id=?')
        .run('review', resultJSON, new Date().toISOString(), task_id);
      this.#event(task_id, 'result_submitted', { attempt_id, producer, result_sha256: resultSHA });
      return this.getTask(task_id);
    });
  }

  reviewTask({ task_id, attempt_id, reviewer, decision, evidence }) {
    text(reviewer, 'reviewer'); text(attempt_id, 'attempt_id');
    if (!/^[a-z][a-z0-9._:-]{0,63}$/.test(reviewer)) fail('INVALID_INPUT', 'reviewer must be a canonical lowercase audit label');
    if (!['accept', 'reject'].includes(decision)) fail('INVALID_INPUT', 'decision must be accept or reject');
    text(evidence, 'evidence');
    return this.#transaction(() => {
      const row = this.#row(task_id);
      if (row.status !== 'review') fail('INVALID_STATE', `Cannot review a ${row.status} task`);
      if (row.attempt_id !== attempt_id) fail('STALE_ATTEMPT', 'Review does not match the current dispatch attempt');
      const result = JSON.parse(row.result_json);
      if (reviewer === result.producer) fail('SELF_REVIEW', 'The producer audit label cannot review its own result');
      const status = decision === 'accept' ? 'done' : 'blocked';
      this.#db.prepare('UPDATE tasks SET status=?,blocked_reason=?,updated_at=? WHERE task_id=?')
        .run(status, decision === 'reject' ? evidence : null, new Date().toISOString(), task_id);
      this.#event(task_id, 'reviewed', { attempt_id, reviewer, decision, evidence, identity_assurance: 'local-operator-asserted' });
      return this.getTask(task_id);
    });
  }

  pauseTask(taskId) {
    return this.#transaction(() => {
      const row = this.#row(taskId);
      if (row.status === 'paused') return decode(row);
      if (!['queued', 'dispatched', 'review'].includes(row.status)) fail('INVALID_STATE', `Cannot pause a ${row.status} task`);
      this.#db.prepare('UPDATE tasks SET status=?,resume_status=?,updated_at=? WHERE task_id=?')
        .run('paused', row.status, new Date().toISOString(), taskId);
      this.#event(taskId, 'paused', { previous_status: row.status });
      return this.getTask(taskId);
    });
  }

  resumeTask(taskId) {
    return this.#transaction(() => {
      const row = this.#row(taskId);
      if (row.status !== 'paused') fail('INVALID_STATE', 'Only paused tasks may resume');
      this.#db.prepare('UPDATE tasks SET status=?,resume_status=NULL,updated_at=? WHERE task_id=?')
        .run(row.resume_status, new Date().toISOString(), taskId);
      this.#event(taskId, 'resumed', { status: row.resume_status });
      return this.getTask(taskId);
    });
  }

  retryTask(taskId, reason) {
    text(reason, 'reason');
    return this.#transaction(() => {
      const row = this.#row(taskId);
      if (row.kind === 'sensitive') fail('HUMAN_REQUIRED', 'Sensitive tasks cannot be unblocked by this prototype');
      if (!['dispatched', 'blocked'].includes(row.status)) fail('INVALID_STATE', 'Only a dispatched or blocked task may be explicitly retried');
      this.#db.prepare('UPDATE tasks SET status=?,attempt_id=NULL,dispatch_json=NULL,result_json=NULL,blocked_reason=NULL,updated_at=? WHERE task_id=?')
        .run('queued', new Date().toISOString(), taskId);
      this.#event(taskId, 'retry_requested', { previous_attempt_id: row.attempt_id, reason });
      return this.getTask(taskId);
    });
  }
}
