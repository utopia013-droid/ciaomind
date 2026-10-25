import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { canonicalJSON } from "../control/core.mjs";

export function fault(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
export function json(value) {
  const result = canonicalJSON(value);
  if (Buffer.byteLength(result) > 1_000_000)
    throw fault("INVALID_INPUT", "JSON exceeds 1 MB");
  return result;
}
export function hash(value) {
  return createHash("sha256").update(json(value), "utf8").digest("hex");
}
const ids = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
function id(value, label) {
  if (typeof value !== "string" || !ids.test(value))
    throw fault(
      "INVALID_INPUT",
      `${label} must be a 1–128 character identifier`,
    );
  return value;
}
function text(value, label, max = 2000) {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw fault("INVALID_INPUT", `${label} must be nonempty text (max ${max})`);
  return value;
}
function integer(value, label, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw fault(
      "INVALID_INPUT",
      `${label} must be an integer between ${min} and ${max}`,
    );
  return value;
}
function strings(value, label, { empty = false, max = 100 } = {}) {
  if (
    !Array.isArray(value) ||
    value.length > max ||
    (!empty && !value.length) ||
    value.some((v) => typeof v !== "string" || !v.trim() || v.length > 2000) ||
    new Set(value).size !== value.length
  )
    throw fault(
      "INVALID_INPUT",
      `${label} must contain unique nonempty strings`,
    );
  return value;
}
function namespace(value) {
  if (!["personal", "project"].includes(value))
    throw fault("INVALID_INPUT", "namespace must be personal or project");
  return value;
}
function keys(value, allowed, label) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((k) => !allowed.includes(k))
  )
    throw fault("INVALID_INPUT", `Unexpected ${label} field`);
}
function normalize(raw) {
  const value = JSON.parse(json(raw));
  keys(
    value,
    [
      "goal_id",
      "namespace",
      "goal_version",
      "objective",
      "acceptance",
      "steps",
      "grants",
      "max_calls",
      "max_attempts",
      "revisit_seconds",
    ],
    "goal",
  );
  const result = {
    goal_id: id(value.goal_id, "goal_id"),
    namespace: namespace(value.namespace),
    goal_version: value.goal_version ?? 1,
    objective: text(value.objective, "objective"),
    acceptance: strings(value.acceptance, "acceptance"),
    grants: strings(value.grants ?? [], "grants", { empty: true }),
    max_calls: integer(value.max_calls ?? 20, "max_calls", 0, 100000),
    max_attempts: integer(value.max_attempts ?? 3, "max_attempts", 1, 20),
    revisit_seconds: integer(
      value.revisit_seconds ?? 0,
      "revisit_seconds",
      0,
      31536000,
    ),
    steps: [],
  };
  if (result.goal_version !== 1)
    throw fault(
      "INVALID_INPUT",
      "This release accepts immutable goal_version 1; changed contracts require a new goal_id",
    );
  if (
    !Array.isArray(value.steps) ||
    !value.steps.length ||
    value.steps.length > 50
  )
    throw fault("INVALID_INPUT", "steps must contain 1–50 explicit tasks");
  for (const step of value.steps) {
    keys(
      step,
      [
        "step_id",
        "kind",
        "worker",
        "reviewer",
        "capability",
        "input",
        "depends_on",
      ],
      "step",
    );
    const kind = text(step.kind ?? "research", "kind", 64);
    result.steps.push({
      step_id: id(step.step_id, "step_id"),
      kind,
      worker: id(step.worker, "worker"),
      reviewer: step.reviewer == null ? null : id(step.reviewer, "reviewer"),
      capability: text(
        step.capability ?? (kind === "office" ? "document.read" : "repo.read"),
        "capability",
        128,
      ),
      input: step.input ?? {},
      depends_on: strings(step.depends_on ?? [], "depends_on", {
        empty: true,
        max: 50,
      }),
    });
  }
  const byId = new Map(result.steps.map((step) => [step.step_id, step]));
  if (byId.size !== result.steps.length)
    throw fault("INVALID_INPUT", "step_id values must be unique");
  const visiting = new Set(),
    visited = new Set();
  function visit(step) {
    if (visiting.has(step.step_id))
      throw fault("INVALID_INPUT", "steps contain a dependency cycle");
    if (visited.has(step.step_id)) return;
    visiting.add(step.step_id);
    for (const dependency of step.depends_on) {
      if (!byId.has(dependency))
        throw fault("INVALID_INPUT", `Unknown dependency ${dependency}`);
      visit(byId.get(dependency));
    }
    visiting.delete(step.step_id);
    visited.add(step.step_id);
  }
  result.steps.forEach(visit);
  return JSON.parse(json(result));
}

const INFRASTRUCTURE = new Set([
  "WORKER_UNAVAILABLE",
  "WORKER_DISABLED",
  "NAMESPACE_DENIED",
  "CAPABILITY_DENIED",
  "GRANT_DENIED",
  "REVIEWER_REQUIRED",
  "SELF_REVIEW",
  "REVIEWER_EFFECTS",
]);

/** Single-user local controller. Adapter identity is a registry binding, not remote authentication. */
export class GoalStore {
  #db;
  #now;
  constructor({ dbPath, now = Date.now }) {
    text(dbPath, "dbPath", 4096);
    this.#now = now;
    if (dbPath !== ":memory:")
      mkdirSync(dirname(resolve(dbPath)), { recursive: true, mode: 0o700 });
    this.#db = new DatabaseSync(dbPath, {
      timeout: 5000,
      allowExtension: false,
    });
    if (dbPath !== ":memory:") chmodSync(dbPath, 0o600);
    this.#db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS goals (
        namespace TEXT NOT NULL, goal_id TEXT NOT NULL, contract_json TEXT NOT NULL, contract_sha256 TEXT NOT NULL,
        status TEXT NOT NULL, calls_reserved INTEGER NOT NULL DEFAULT 0, cycle INTEGER NOT NULL DEFAULT 0,
        next_wake_at INTEGER, blocked_reason TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        PRIMARY KEY(namespace,goal_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS goal_steps (
        namespace TEXT NOT NULL,goal_id TEXT NOT NULL,step_id TEXT NOT NULL,ordinal INTEGER NOT NULL,spec_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',phase TEXT NOT NULL DEFAULT 'task',attempt_id TEXT,input_sha256 TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,review_attempts INTEGER NOT NULL DEFAULT 0,result_json TEXT,review_json TEXT,
        blocked_reason TEXT,next_attempt_at INTEGER,lease_until INTEGER,lease_owner TEXT,lease_token TEXT,effects TEXT,task_effects TEXT,
        PRIMARY KEY(namespace,goal_id,step_id),FOREIGN KEY(namespace,goal_id) REFERENCES goals(namespace,goal_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS goal_events (
        event_id INTEGER PRIMARY KEY AUTOINCREMENT,namespace TEXT NOT NULL,goal_id TEXT NOT NULL,type TEXT NOT NULL,
        detail_json TEXT NOT NULL,created_at INTEGER NOT NULL,FOREIGN KEY(namespace,goal_id) REFERENCES goals(namespace,goal_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS goal_calls (
        call_id TEXT PRIMARY KEY,namespace TEXT NOT NULL,goal_id TEXT NOT NULL,step_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL,phase TEXT NOT NULL,owner TEXT NOT NULL,effects TEXT NOT NULL,
        packet_json TEXT NOT NULL,status TEXT NOT NULL,result_json TEXT,error_json TEXT,
        created_at INTEGER NOT NULL,finished_at INTEGER,FOREIGN KEY(namespace,goal_id) REFERENCES goals(namespace,goal_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS goal_lease_expiry ON goal_steps(status,lease_until);
    `);
    if (
      !this.#db
        .prepare("PRAGMA table_info(goal_steps)")
        .all()
        .some((column) => column.name === "task_effects")
    )
      this.#db.exec("ALTER TABLE goal_steps ADD COLUMN task_effects TEXT");
  }
  close() {
    this.#db.close();
  }
  _useClock(now) {
    if (typeof now !== "function")
      throw fault("INVALID_CLOCK", "now must be a clock function");
    const previous = this.#now;
    this.#now = now;
    try {
      this._time();
    } catch (error) {
      this.#now = previous;
      throw error;
    }
  }
  _time() {
    const value = this.#now();
    const time = value instanceof Date ? value.getTime() : value;
    if (!Number.isFinite(time))
      throw fault("INVALID_CLOCK", "Clock must return epoch milliseconds");
    return time;
  }
  #tx(fn) {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      this.#db.exec("COMMIT");
      return value;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }
  #goal(ns, goalId) {
    namespace(ns);
    id(goalId, "goal_id");
    const row = this.#db
      .prepare("SELECT * FROM goals WHERE namespace=? AND goal_id=?")
      .get(ns, goalId);
    if (!row) throw fault("NOT_FOUND", `Unknown goal ${ns}/${goalId}`);
    return row;
  }
  #steps(ns, goalId) {
    return this.#db
      .prepare(
        "SELECT * FROM goal_steps WHERE namespace=? AND goal_id=? ORDER BY ordinal",
      )
      .all(ns, goalId);
  }
  #step(ns, goalId, stepId) {
    const row = this.#db
      .prepare(
        "SELECT * FROM goal_steps WHERE namespace=? AND goal_id=? AND step_id=?",
      )
      .get(ns, goalId, stepId);
    if (!row) throw fault("NOT_FOUND", "Unknown step");
    return row;
  }
  #event(ns, goalId, type, detail = {}) {
    this.#db
      .prepare(
        "INSERT INTO goal_events(namespace,goal_id,type,detail_json,created_at) VALUES(?,?,?,?,?)",
      )
      .run(ns, goalId, type, json(detail), this._time());
  }
  #touch(ns, goalId, status, reason = null, wake = null) {
    this.#db
      .prepare(
        "UPDATE goals SET status=?,blocked_reason=?,next_wake_at=?,updated_at=? WHERE namespace=? AND goal_id=?",
      )
      .run(status, reason, wake, this._time(), ns, goalId);
  }
  #refresh(ns, goalId) {
    const goal = this.#goal(ns, goalId);
    if (
      ["paused", "cancelled", "maintenance", "completed"].includes(goal.status)
    )
      return;
    const spec = JSON.parse(goal.contract_json),
      steps = this.#steps(ns, goalId),
      done = new Set(
        steps.filter((s) => s.status === "done").map((s) => s.step_id),
      );
    if (done.size === steps.length) {
      const next = spec.revisit_seconds
        ? this._time() + spec.revisit_seconds * 1000
        : null;
      this.#touch(
        ns,
        goalId,
        next == null ? "completed" : "maintenance",
        null,
        next,
      );
      this.#event(ns, goalId, "goal_completed", {
        cycle: goal.cycle,
        next_wake_at: next,
      });
      return;
    }
    const runnable = steps.some(
      (s) =>
        ["running", "review"].includes(s.status) ||
        (s.status === "pending" &&
          JSON.parse(s.spec_json).depends_on.every((d) => done.has(d))),
    );
    const reason =
      steps.find((s) => s.status === "blocked")?.blocked_reason ?? null;
    const wake = steps
      .filter(
        (s) =>
          s.next_attempt_at != null && ["pending", "review"].includes(s.status),
      )
      .reduce((min, s) => Math.min(min, s.next_attempt_at), Infinity);
    this.#touch(
      ns,
      goalId,
      runnable ? "active" : "blocked",
      reason,
      Number.isFinite(wake) ? wake : null,
    );
  }
  createGoal(raw) {
    const spec = normalize(raw),
      content = json(spec),
      sha = hash(spec),
      ns = spec.namespace,
      goalId = spec.goal_id;
    return this.#tx(() => {
      const existing = this.#db
        .prepare(
          "SELECT contract_sha256 FROM goals WHERE namespace=? AND goal_id=?",
        )
        .get(ns, goalId);
      if (existing) {
        if (existing.contract_sha256 !== sha)
          throw fault(
            "INPUT_CONFLICT",
            "Goal identity already has a different immutable contract",
          );
        return this.getGoal(ns, goalId);
      }
      const now = this._time();
      this.#db
        .prepare(
          "INSERT INTO goals(namespace,goal_id,contract_json,contract_sha256,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
        )
        .run(ns, goalId, content, sha, "active", now, now);
      spec.steps.forEach((step, ordinal) =>
        this.#db
          .prepare(
            "INSERT INTO goal_steps(namespace,goal_id,step_id,ordinal,spec_json) VALUES(?,?,?,?,?)",
          )
          .run(ns, goalId, step.step_id, ordinal, json(step)),
      );
      this.#event(ns, goalId, "goal_created", {
        contract_sha256: sha,
        goal_version: 1,
        steps: spec.steps.length,
        max_calls: spec.max_calls,
      });
      return this.getGoal(ns, goalId);
    });
  }
  getGoal(ns, goalId) {
    const row = this.#goal(ns, goalId),
      spec = JSON.parse(row.contract_json);
    return {
      ...spec,
      contract_sha256: row.contract_sha256,
      status: row.status,
      calls_reserved: row.calls_reserved,
      cycle: row.cycle,
      next_wake_at: row.next_wake_at,
      blocked_reason: row.blocked_reason,
      created_at: row.created_at,
      updated_at: row.updated_at,
      steps: this.#steps(ns, goalId).map((s) => ({
        ...JSON.parse(s.spec_json),
        status: s.status,
        phase: s.phase,
        attempt_id: s.attempt_id,
        input_sha256: s.input_sha256,
        attempts: s.attempts,
        review_attempts: s.review_attempts,
        result: s.result_json ? JSON.parse(s.result_json) : null,
        review: s.review_json ? JSON.parse(s.review_json) : null,
        blocked_reason: s.blocked_reason,
        next_attempt_at: s.next_attempt_at,
        lease_until: s.lease_until,
      })),
    };
  }
  listGoals(ns) {
    if (ns !== undefined) namespace(ns);
    return (
      ns === undefined
        ? this.#db
            .prepare(
              "SELECT namespace,goal_id FROM goals ORDER BY created_at,namespace,goal_id",
            )
            .all()
        : this.#db
            .prepare(
              "SELECT namespace,goal_id FROM goals WHERE namespace=? ORDER BY created_at,goal_id",
            )
            .all(ns)
    ).map((row) => this.getGoal(row.namespace, row.goal_id));
  }
  events(ns, goalId) {
    this.#goal(ns, goalId);
    return this.#db
      .prepare(
        "SELECT * FROM goal_events WHERE namespace=? AND goal_id=? ORDER BY event_id",
      )
      .all(ns, goalId)
      .map((row) => ({
        event_id: row.event_id,
        namespace: row.namespace,
        goal_id: row.goal_id,
        type: row.type,
        detail: JSON.parse(row.detail_json),
        created_at: row.created_at,
      }));
  }
  calls(ns, goalId) {
    this.#goal(ns, goalId);
    return this.#db
      .prepare(
        "SELECT * FROM goal_calls WHERE namespace=? AND goal_id=? ORDER BY created_at,call_id",
      )
      .all(ns, goalId)
      .map((row) => ({
        call_id: row.call_id,
        namespace: row.namespace,
        goal_id: row.goal_id,
        step_id: row.step_id,
        attempt_id: row.attempt_id,
        phase: row.phase,
        owner: row.owner,
        effects: row.effects,
        status: row.status,
        packet: JSON.parse(row.packet_json),
        result: row.result_json ? JSON.parse(row.result_json) : null,
        error: row.error_json ? JSON.parse(row.error_json) : null,
        created_at: row.created_at,
        finished_at: row.finished_at,
      }));
  }
  pauseGoal(ns, goalId) {
    return this.#tx(() => {
      const row = this.#goal(ns, goalId);
      if (["cancelled", "completed"].includes(row.status))
        throw fault("INVALID_STATE", "Cannot pause a terminal goal");
      if (row.status !== "paused") {
        this.#touch(ns, goalId, "paused", row.blocked_reason, row.next_wake_at);
        this.#event(ns, goalId, "goal_paused");
      }
      return this.getGoal(ns, goalId);
    });
  }
  resumeGoal(ns, goalId) {
    return this.#tx(() => {
      const row = this.#goal(ns, goalId);
      if (row.status !== "paused")
        throw fault("INVALID_STATE", "Only paused goals may resume");
      this.#touch(ns, goalId, "active");
      this.#event(ns, goalId, "goal_resumed");
      this.#refresh(ns, goalId);
      return this.getGoal(ns, goalId);
    });
  }
  cancelGoal(ns, goalId) {
    return this.#tx(() => {
      const row = this.#goal(ns, goalId);
      if (row.status !== "cancelled") {
        this.#db
          .prepare(
            "UPDATE goal_calls SET status='cancelled',error_json=?,finished_at=? WHERE namespace=? AND goal_id=? AND status='reserved'",
          )
          .run(
            json({
              code: "CANCELLED",
              in_flight_outcome_may_be_uncertain: true,
            }),
            this._time(),
            ns,
            goalId,
          );
        this.#db
          .prepare(
            "UPDATE goal_steps SET status='blocked',blocked_reason='CANCELLED: goal cancelled; any in-flight action may be uncertain',lease_until=NULL,lease_owner=NULL,lease_token=NULL WHERE namespace=? AND goal_id=? AND status<>'done'",
          )
          .run(ns, goalId);
        this.#touch(
          ns,
          goalId,
          "cancelled",
          "CANCELLED: operator cancelled goal",
        );
        this.#event(ns, goalId, "goal_cancelled", {
          in_flight_may_continue: true,
        });
      }
      return this.getGoal(ns, goalId);
    });
  }
  retryBlocked(ns, goalId, { step_id } = {}) {
    return this.#tx(() => {
      const row = this.#goal(ns, goalId),
        spec = JSON.parse(row.contract_json);
      if (
        ["cancelled", "paused", "completed", "maintenance"].includes(row.status)
      )
        throw fault(
          "INVALID_STATE",
          "Goal must be active or blocked before retry",
        );
      const candidates = this.#steps(ns, goalId).filter(
        (s) => s.status === "blocked" && (!step_id || s.step_id === step_id),
      );
      if (!candidates.length)
        throw fault("INVALID_STATE", "No matching blocked step");
      for (const step of candidates) {
        if (step.blocked_reason?.includes("UNCERTAIN"))
          throw fault(
            "OUTCOME_UNCERTAIN",
            "Verify the external outcome before creating a new explicitly authorized task",
          );
        if (
          (step.phase === "review" ? step.review_attempts : step.attempts) >=
          spec.max_attempts
        )
          throw fault(
            "ATTEMPTS_EXHAUSTED",
            "Attempt limit reached; create a revised goal contract",
          );
        if (row.calls_reserved >= spec.max_calls)
          throw fault("BUDGET_EXHAUSTED", "Call reservation budget exhausted");
        const phase = step.phase;
        this.#db
          .prepare(
            "UPDATE goal_steps SET status=?,blocked_reason=NULL,next_attempt_at=NULL,lease_until=NULL,lease_owner=NULL,lease_token=NULL,result_json=CASE WHEN ?='task' THEN NULL ELSE result_json END,review_json=NULL WHERE namespace=? AND goal_id=? AND step_id=?",
          )
          .run(
            phase === "review" ? "review" : "pending",
            phase,
            ns,
            goalId,
            step.step_id,
          );
        this.#event(ns, goalId, "operator_retry", {
          step_id: step.step_id,
          phase,
        });
      }
      this.#touch(ns, goalId, "active");
      this.#refresh(ns, goalId);
      return this.getGoal(ns, goalId);
    });
  }
  _recoverExpired(ns) {
    if (ns !== undefined) namespace(ns);
    return this.#tx(() => {
      const rows =
        ns === undefined
          ? this.#db
              .prepare(
                "SELECT * FROM goal_steps WHERE status='running' AND lease_until<=?",
              )
              .all(this._time())
          : this.#db
              .prepare(
                "SELECT * FROM goal_steps WHERE status='running' AND lease_until<=? AND namespace=?",
              )
              .all(this._time(), ns);
      for (const step of rows) {
        const goal = this.#goal(step.namespace, step.goal_id),
          spec = JSON.parse(goal.contract_json);
        const safe =
          step.effects === "read-only" &&
          (step.phase === "review" ? step.review_attempts : step.attempts) <
            spec.max_attempts;
        const reason = safe
          ? null
          : step.effects !== "read-only"
            ? "LEASE_EXPIRED_UNCERTAIN: external action outcome must be verified"
            : "ATTEMPTS_EXHAUSTED: expired read-only call reached attempt limit";
        this.#db
          .prepare(
            "UPDATE goal_calls SET status='expired',error_json=?,finished_at=? WHERE call_id=? AND status='reserved'",
          )
          .run(
            json({
              code: "LEASE_EXPIRED",
              read_only_retry: safe,
              outcome_uncertain: step.effects !== "read-only",
            }),
            this._time(),
            step.lease_token,
          );
        this.#db
          .prepare(
            "UPDATE goal_steps SET status=?,blocked_reason=?,next_attempt_at=?,lease_until=NULL,lease_owner=NULL,lease_token=NULL WHERE namespace=? AND goal_id=? AND step_id=?",
          )
          .run(
            safe ? (step.phase === "review" ? "review" : "pending") : "blocked",
            reason,
            safe ? this._time() + 1000 : null,
            step.namespace,
            step.goal_id,
            step.step_id,
          );
        this.#event(step.namespace, step.goal_id, "lease_recovered", {
          step_id: step.step_id,
          attempt_id: step.attempt_id,
          read_only_retry: safe,
          outcome_uncertain: step.effects !== "read-only",
        });
        this.#refresh(step.namespace, step.goal_id);
      }
      return rows.length;
    });
  }
  _maintenance(ns, goalId, eligible) {
    return this.#tx(() => {
      const goal = this.#goal(ns, goalId);
      if (goal.status !== "maintenance" || goal.next_wake_at > this._time())
        return false;
      const steps = this.#steps(ns, goalId),
        spec = JSON.parse(goal.contract_json);
      const issue = steps
        .flatMap((s) => [
          eligible(JSON.parse(s.spec_json), "task", spec),
          eligible(JSON.parse(s.spec_json), "review", spec),
        ])
        .find(Boolean);
      const write = steps.some(
        (s) =>
          s.task_effects !== "read-only" ||
          eligible(JSON.parse(s.spec_json), "task", spec, true)?.effects ===
            "write",
      );
      if (write || issue) {
        this.#touch(
          ns,
          goalId,
          write ? "blocked" : "maintenance",
          write
            ? "MAINTENANCE_WRITE_DENIED: completed write tasks are not repeated"
            : `MAINTENANCE_BLOCKED: ${issue.code}: ${issue.message}`,
          write ? null : this._time() + spec.revisit_seconds * 1000,
        );
        this.#event(ns, goalId, "maintenance_blocked", {
          reason: write ? "write-task" : issue.code,
        });
        return true;
      }
      this.#db
        .prepare(
          "UPDATE goal_steps SET status='pending',phase='task',attempt_id=NULL,input_sha256=NULL,attempts=0,review_attempts=0,result_json=NULL,review_json=NULL,blocked_reason=NULL,next_attempt_at=NULL,lease_until=NULL,lease_owner=NULL,lease_token=NULL,effects=NULL,task_effects=NULL WHERE namespace=? AND goal_id=?",
        )
        .run(ns, goalId);
      this.#db
        .prepare(
          "UPDATE goals SET status='active',cycle=cycle+1,next_wake_at=NULL,blocked_reason=NULL,updated_at=? WHERE namespace=? AND goal_id=?",
        )
        .run(this._time(), ns, goalId);
      this.#event(ns, goalId, "maintenance_cycle_started", {
        cycle: goal.cycle + 1,
        read_only: true,
      });
      return true;
    });
  }
  _claim(ns, goalId, { owner, leaseMs, eligible }) {
    return this.#tx(() => {
      let goal = this.#goal(ns, goalId);
      if (
        !["active", "blocked"].includes(goal.status) ||
        goal.blocked_reason?.startsWith("MAINTENANCE_")
      )
        return null;
      const spec = JSON.parse(goal.contract_json);
      let steps = this.#steps(ns, goalId);
      // Recheck only configuration blockers; authentication errors require an explicit operator retry.
      for (const step of steps.filter(
        (s) =>
          s.status === "blocked" &&
          INFRASTRUCTURE.has(s.blocked_reason?.split(":")[0]),
      )) {
        if (!eligible(JSON.parse(step.spec_json), step.phase, spec)) {
          this.#db
            .prepare(
              "UPDATE goal_steps SET status=?,blocked_reason=NULL WHERE namespace=? AND goal_id=? AND step_id=?",
            )
            .run(
              step.phase === "review" ? "review" : "pending",
              ns,
              goalId,
              step.step_id,
            );
          this.#event(ns, goalId, "blocker_resolved", {
            step_id: step.step_id,
          });
        }
      }
      steps = this.#steps(ns, goalId);
      const done = new Set(
        steps.filter((s) => s.status === "done").map((s) => s.step_id),
      );
      for (const step of [...steps].sort(
        (a, b) =>
          (a.status === "review" ? 0 : 1) - (b.status === "review" ? 0 : 1) ||
          a.ordinal - b.ordinal,
      )) {
        if (
          !["pending", "review"].includes(step.status) ||
          step.next_attempt_at > this._time()
        )
          continue;
        const definition = JSON.parse(step.spec_json);
        if (!definition.depends_on.every((d) => done.has(d))) continue;
        const phase = step.status === "review" ? "review" : "task";
        const issue = eligible(definition, phase, spec);
        let blocked = issue;
        if (!blocked && goal.calls_reserved >= spec.max_calls)
          blocked = {
            code: "BUDGET_EXHAUSTED",
            message: "Goal call reservation limit reached",
          };
        if (
          !blocked &&
          (phase === "review" ? step.review_attempts : step.attempts) >=
            spec.max_attempts
        )
          blocked = {
            code: "ATTEMPTS_EXHAUSTED",
            message: "Step attempt limit reached",
          };
        if (blocked) {
          this.#db
            .prepare(
              "UPDATE goal_steps SET status='blocked',phase=?,blocked_reason=?,next_attempt_at=NULL WHERE namespace=? AND goal_id=? AND step_id=?",
            )
            .run(
              phase,
              `${blocked.code}: ${blocked.message}`,
              ns,
              goalId,
              step.step_id,
            );
          this.#event(ns, goalId, "step_blocked", {
            step_id: step.step_id,
            phase,
            ...blocked,
          });
          continue;
        }
        const dependencies = Object.fromEntries(
          steps
            .filter((s) => definition.depends_on.includes(s.step_id))
            .map((s) => [s.step_id, JSON.parse(s.result_json).output]),
        );
        const inputSHA =
          phase === "review"
            ? step.input_sha256
            : hash({
                namespace: ns,
                goal_id: goalId,
                goal_version: 1,
                cycle: goal.cycle,
                step: definition,
                dependencies,
              });
        const attempt = phase === "review" ? step.attempt_id : randomUUID(),
          token = randomUUID(),
          lease = this._time() + leaseMs;
        const worker =
          phase === "review" ? definition.reviewer : definition.worker;
        const capability =
          phase === "review" ? "review" : definition.capability;
        const packet = {
          protocol: "ciaomind.goal-worker.v1",
          type: phase,
          namespace: ns,
          goal_id: goalId,
          goal_version: 1,
          step_id: step.step_id,
          task_id: `${ns}/${goalId}/${step.step_id}`,
          input_sha256: inputSHA,
          attempt_id: attempt,
          worker,
          kind: definition.kind,
          capability,
          input: definition.input,
          dependencies,
          objective: spec.objective,
          acceptance: spec.acceptance,
          lease_until: lease,
          deadline: lease,
          grant: { namespace: ns, capability },
          idempotency_key: `${ns}/${goalId}/${step.step_id}/${attempt}/${phase}`,
        };
        if (phase === "review") packet.result = JSON.parse(step.result_json);
        // Validate packet bounds before reserving budget or state.
        json(packet);
        const effects = eligible(definition, phase, spec, true).effects;
        this.#db
          .prepare(
            "UPDATE goal_steps SET status='running',phase=?,attempt_id=?,input_sha256=?,attempts=attempts+?,review_attempts=review_attempts+?,lease_until=?,lease_owner=?,lease_token=?,effects=?,task_effects=CASE WHEN ?='task' THEN ? ELSE task_effects END,blocked_reason=NULL,next_attempt_at=NULL WHERE namespace=? AND goal_id=? AND step_id=?",
          )
          .run(
            phase,
            attempt,
            inputSHA,
            phase === "task" ? 1 : 0,
            phase === "review" ? 1 : 0,
            lease,
            owner,
            token,
            effects,
            phase,
            effects,
            ns,
            goalId,
            step.step_id,
          );
        this.#db
          .prepare(
            "UPDATE goals SET calls_reserved=calls_reserved+1,status=?,blocked_reason=NULL,updated_at=? WHERE namespace=? AND goal_id=?",
          )
          .run("active", this._time(), ns, goalId);
        this.#db
          .prepare(
            "INSERT INTO goal_calls(call_id,namespace,goal_id,step_id,attempt_id,phase,owner,effects,packet_json,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
          )
          .run(
            token,
            ns,
            goalId,
            step.step_id,
            attempt,
            phase,
            owner,
            effects,
            json(packet),
            "reserved",
            this._time(),
          );
        this.#event(ns, goalId, "call_reserved", {
          step_id: step.step_id,
          phase,
          attempt_id: attempt,
          worker,
          lease_until: lease,
        });
        return { packet, token, owner, phase };
      }
      this.#refresh(ns, goalId);
      return null;
    });
  }
  #current(claim, allowExpired = false) {
    const p = claim.packet,
      row = this.#step(p.namespace, p.goal_id, p.step_id);
    if (
      row.status !== "running" ||
      row.lease_token !== claim.token ||
      row.lease_owner !== claim.owner ||
      row.attempt_id !== p.attempt_id ||
      row.phase !== claim.phase ||
      (!allowExpired && row.lease_until <= this._time())
    )
      throw fault("STALE_ATTEMPT", "Call no longer owns an active lease");
    return row;
  }
  _finish(claim, raw) {
    const result = JSON.parse(json(raw)),
      p = claim.packet;
    for (const key of [
      "namespace",
      "goal_id",
      "goal_version",
      "step_id",
      "task_id",
      "input_sha256",
      "attempt_id",
    ])
      if (result[key] !== p[key])
        throw fault("RESULT_MISMATCH", `Result identity mismatch: ${key}`);
    if (result.producer !== p.worker)
      throw fault(
        "PRODUCER_MISMATCH",
        "Result producer does not match selected registry worker",
      );
    strings(result.evidence, "result.evidence");
    if (p.type === "task" && !Object.hasOwn(result, "output"))
      throw fault("INVALID_RESULT", "Task requires output");
    if (p.type === "review" && !["accept", "reject"].includes(result.decision))
      throw fault("INVALID_RESULT", "Review requires accept/reject");
    return this.#tx(() => {
      const row = this.#current(claim),
        ns = p.namespace,
        goalId = p.goal_id;
      this.#db
        .prepare(
          "UPDATE goal_calls SET status='completed',result_json=?,finished_at=? WHERE call_id=?",
        )
        .run(json(result), this._time(), claim.token);
      if (p.type === "task") {
        this.#db
          .prepare(
            "UPDATE goal_steps SET status='review',phase='review',result_json=?,review_json=NULL,review_attempts=0,lease_until=NULL,lease_owner=NULL,lease_token=NULL WHERE namespace=? AND goal_id=? AND step_id=?",
          )
          .run(json(result), ns, goalId, p.step_id);
        this.#event(ns, goalId, "result_received", {
          step_id: p.step_id,
          attempt_id: p.attempt_id,
          result_sha256: hash(result),
        });
      } else {
        const original = JSON.parse(row.result_json);
        if (result.producer === original.producer)
          throw fault("SELF_REVIEW", "Producer cannot accept its own result");
        const accept = result.decision === "accept";
        this.#db
          .prepare(
            "UPDATE goal_steps SET status=?,phase=?,review_json=?,blocked_reason=?,lease_until=NULL,lease_owner=NULL,lease_token=NULL WHERE namespace=? AND goal_id=? AND step_id=?",
          )
          .run(
            accept ? "done" : "blocked",
            accept ? "review" : "task",
            json(result),
            accept
              ? null
              : "REVIEW_REJECTED: independent review rejected this attempt",
            ns,
            goalId,
            p.step_id,
          );
        this.#event(ns, goalId, "independent_review", {
          step_id: p.step_id,
          attempt_id: p.attempt_id,
          reviewer: result.producer,
          decision: result.decision,
          evidence: result.evidence,
          identity_assurance: "adapter-registry-binding",
        });
      }
      this.#refresh(ns, goalId);
      return this.getGoal(ns, goalId);
    });
  }
  _fail(claim, error) {
    return this.#tx(() => {
      let row;
      try {
        row = this.#current(claim, true);
      } catch (e) {
        if (e.code === "STALE_ATTEMPT") return false;
        throw e;
      }
      const p = claim.packet,
        goal = this.#goal(p.namespace, p.goal_id),
        spec = JSON.parse(goal.contract_json),
        code = typeof error?.code === "string" ? error.code : "WORKER_ERROR";
      // Only the trusted adapter can attest a preflight failure. An AUTH_REQUIRED
      // response after a process/request began is not proof that no call occurred.
      const notStarted = error?.notStarted === true,
        count = claim.phase === "review" ? row.review_attempts : row.attempts;
      const retry =
        !notStarted &&
        row.effects === "read-only" &&
        error?.retryable === true &&
        count < spec.max_attempts &&
        goal.calls_reserved < spec.max_calls;
      const uncertain = !notStarted && row.effects !== "read-only";
      const reason = `${uncertain ? "OUTCOME_UNCERTAIN" : code}: ${String(error?.message ?? "Worker failed").slice(0, 1000)}`;
      this.#db
        .prepare(
          "UPDATE goal_calls SET status=?,error_json=?,finished_at=? WHERE call_id=?",
        )
        .run(
          notStarted ? "not_started" : "failed",
          json({
            code,
            message: String(error?.message ?? "Worker failed").slice(0, 1000),
            not_started: notStarted,
            retry_scheduled: retry,
            outcome_uncertain: uncertain,
          }),
          this._time(),
          claim.token,
        );
      this.#db
        .prepare(
          "UPDATE goal_steps SET status=?,blocked_reason=?,next_attempt_at=?,attempts=attempts-?,review_attempts=review_attempts-?,lease_until=NULL,lease_owner=NULL,lease_token=NULL WHERE namespace=? AND goal_id=? AND step_id=?",
        )
        .run(
          retry ? (claim.phase === "review" ? "review" : "pending") : "blocked",
          retry ? null : reason,
          retry
            ? this._time() + Math.min(60000, 1000 * 2 ** Math.max(0, count - 1))
            : null,
          notStarted && claim.phase === "task" ? 1 : 0,
          notStarted && claim.phase === "review" ? 1 : 0,
          p.namespace,
          p.goal_id,
          p.step_id,
        );
      if (notStarted)
        this.#db
          .prepare(
            "UPDATE goals SET calls_reserved=calls_reserved-1 WHERE namespace=? AND goal_id=?",
          )
          .run(p.namespace, p.goal_id);
      this.#event(
        p.namespace,
        p.goal_id,
        notStarted ? "call_not_started" : "call_failed",
        {
          step_id: p.step_id,
          phase: claim.phase,
          attempt_id: p.attempt_id,
          code,
          retry_scheduled: retry,
          outcome_uncertain: uncertain,
          message: String(error?.message ?? "Worker failed").slice(0, 1000),
        },
      );
      this.#refresh(p.namespace, p.goal_id);
      return true;
    });
  }
}
