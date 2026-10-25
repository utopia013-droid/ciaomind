import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { GoalStore, json, hash, fault } from "../orchestrator/store.mjs";
import { Coordinator } from "../orchestrator/engine.mjs";

const IDENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const safeText = (v, n, max = 2000) => {
  if (typeof v !== "string" || !v.trim() || v.length > max)
    throw fault("INVALID_INPUT", `${n} must be nonempty text`);
  return v;
};
const ident = (v, n) => {
  if (typeof v !== "string" || !IDENT.test(v))
    throw fault("INVALID_INPUT", `${n} must be a 1–100 character identifier`);
  return v;
};
const strings = (v, n) => {
  if (
    !Array.isArray(v) ||
    !v.length ||
    v.length > 50 ||
    new Set(v).size !== v.length ||
    v.some((x) => typeof x !== "string" || !x.trim() || x.length > 2000)
  )
    throw fault("INVALID_INPUT", `${n} must contain unique nonempty strings`);
  return v;
};
const integer = (v, n, min, max) => {
  if (!Number.isSafeInteger(v) || v < min || v > max)
    throw fault("INVALID_INPUT", `${n} must be ${min}–${max}`);
  return v;
};
const scope = (ns) => {
  if (!["project", "personal"].includes(ns))
    throw fault("INVALID_INPUT", "namespace must be project or personal");
  return ns;
};
function normalize(raw) {
  const x = JSON.parse(json(raw));
  if (
    !x ||
    Array.isArray(x) ||
    Object.keys(x).some(
      (k) =>
        ![
          "mission_id",
          "namespace",
          "mode",
          "objective",
          "acceptance",
          "grants",
          "planner",
          "reviewer",
          "allowed_workers",
          "max_calls",
          "max_cycles",
          "revisit_seconds",
        ].includes(k),
    )
  )
    throw fault("INVALID_INPUT", "Unknown mission field");
  if (x.mode !== undefined && !["live", "demo"].includes(x.mode))
    throw fault("INVALID_INPUT", "mode must be live or demo");
  const out = {
    mission_id: ident(x.mission_id, "mission_id"),
    namespace: scope(x.namespace),
    mode: x.mode ?? "live",
    objective: safeText(x.objective, "objective"),
    acceptance: strings(x.acceptance, "acceptance"),
    grants: strings(x.grants, "grants"),
    planner: ident(x.planner, "planner"),
    reviewer: ident(x.reviewer, "reviewer"),
    allowed_workers: strings(x.allowed_workers, "allowed_workers").map((v) =>
      ident(v, "allowed worker"),
    ),
    max_calls: integer(x.max_calls ?? 20, "max_calls", 0, 100000),
    max_cycles: integer(x.max_cycles ?? 3, "max_cycles", 1, 50),
    revisit_seconds: integer(
      x.revisit_seconds ?? 0,
      "revisit_seconds",
      0,
      31536000,
    ),
  };
  if (out.planner === out.reviewer)
    throw fault(
      "SELF_REVIEW",
      "Mission planner and reviewer must be different registry identities",
    );
  if (!out.grants.includes("review"))
    throw fault("GRANT_DENIED", "Mission requires an explicit review grant");
  return out;
}

/** Private single-owner mission ledger. Identity labels do not authenticate remote callers. */
export class MissionStore {
  #db;
  #now;
  constructor({ dbPath, now = Date.now }) {
    safeText(dbPath, "dbPath", 4096);
    this.#now = now;
    if (dbPath !== ":memory:")
      mkdirSync(dirname(resolve(dbPath)), { recursive: true, mode: 0o700 });
    this.#db = new DatabaseSync(dbPath, {
      timeout: 5000,
      allowExtension: false,
    });
    if (dbPath !== ":memory:") chmodSync(dbPath, 0o600);
    this.#db.exec(`PRAGMA journal_mode=WAL;
   CREATE TABLE IF NOT EXISTS missions(namespace TEXT NOT NULL,mission_id TEXT NOT NULL,contract_json TEXT NOT NULL,contract_sha256 TEXT NOT NULL,status TEXT NOT NULL,phase TEXT NOT NULL,cycle INTEGER NOT NULL DEFAULT 0,calls_reserved INTEGER NOT NULL DEFAULT 0,plan_json TEXT,child_json TEXT,child_goal_id TEXT,observations_json TEXT NOT NULL DEFAULT '[]',blocked_reason TEXT,next_wake_at INTEGER,resume_status TEXT,lease_token TEXT,lease_until INTEGER,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(namespace,mission_id)) STRICT;
   CREATE TABLE IF NOT EXISTS mission_calls(attempt_id TEXT PRIMARY KEY,namespace TEXT NOT NULL,mission_id TEXT NOT NULL,phase TEXT NOT NULL,packet_json TEXT NOT NULL,result_json TEXT,error_json TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL) STRICT;
   CREATE TABLE IF NOT EXISTS mission_events(event_id INTEGER PRIMARY KEY AUTOINCREMENT,namespace TEXT NOT NULL,mission_id TEXT NOT NULL,type TEXT NOT NULL,detail_json TEXT NOT NULL,created_at INTEGER NOT NULL) STRICT;`);
    if (
      !this.#db
        .prepare("PRAGMA table_info(missions)")
        .all()
        .some((c) => c.name === "resume_status")
    )
      this.#db.exec("ALTER TABLE missions ADD COLUMN resume_status TEXT");
  }
  close() {
    this.#db.close();
  }
  _time() {
    const n = this.#now();
    const t = n instanceof Date ? n.getTime() : n;
    if (!Number.isFinite(t))
      throw fault("INVALID_CLOCK", "Clock must return epoch milliseconds");
    return t;
  }
  #tx(fn) {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const x = fn();
      this.#db.exec("COMMIT");
      return x;
    } catch (e) {
      this.#db.exec("ROLLBACK");
      throw e;
    }
  }
  #row(ns, id) {
    scope(ns);
    ident(id, "mission_id");
    const r = this.#db
      .prepare("SELECT * FROM missions WHERE namespace=? AND mission_id=?")
      .get(ns, id);
    if (!r) throw fault("NOT_FOUND", "Unknown mission");
    return r;
  }
  #event(ns, id, type, detail = {}) {
    this.#db
      .prepare(
        "INSERT INTO mission_events(namespace,mission_id,type,detail_json,created_at) VALUES(?,?,?,?,?)",
      )
      .run(ns, id, type, json(detail), this._time());
  }
  #decode(r) {
    return {
      ...JSON.parse(r.contract_json),
      mission_version: 1,
      contract_sha256: r.contract_sha256,
      status: r.status,
      phase: r.phase,
      cycle: r.cycle,
      calls_reserved: r.calls_reserved,
      plan: r.plan_json ? JSON.parse(r.plan_json) : null,
      child_goal: r.child_json ? JSON.parse(r.child_json) : null,
      child_goal_id: r.child_goal_id,
      observations: JSON.parse(r.observations_json),
      blocked_reason: r.blocked_reason,
      resume_status: r.resume_status,
      next_wake_at: r.next_wake_at,
      lease_until: r.lease_until,
      created_at: r.created_at,
      updated_at: r.updated_at,
    };
  }
  createMission(raw) {
    const spec = normalize(raw),
      content = json(spec),
      sha = hash(spec);
    return this.#tx(() => {
      const old = this.#db
        .prepare("SELECT * FROM missions WHERE namespace=? AND mission_id=?")
        .get(spec.namespace, spec.mission_id);
      if (old) {
        if (old.contract_sha256 !== sha)
          throw fault(
            "INPUT_CONFLICT",
            "Mission contract is immutable; create a new mission_id for a changed objective or authorization",
          );
        return this.#decode(old);
      }
      const t = this._time();
      this.#db
        .prepare(
          "INSERT INTO missions(namespace,mission_id,contract_json,contract_sha256,status,phase,created_at,updated_at) VALUES(?,?,?,?,'active','plan',?,?)",
        )
        .run(spec.namespace, spec.mission_id, content, sha, t, t);
      this.#event(spec.namespace, spec.mission_id, "mission_created", {
        contract_sha256: sha,
        max_calls: spec.max_calls,
        max_cycles: spec.max_cycles,
      });
      return this.getMission(spec.namespace, spec.mission_id);
    });
  }
  getMission(ns, id) {
    return this.#decode(this.#row(ns, id));
  }
  listMissions(ns) {
    if (ns !== undefined) scope(ns);
    return (
      ns === undefined
        ? this.#db
            .prepare(
              "SELECT * FROM missions ORDER BY created_at,namespace,mission_id",
            )
            .all()
        : this.#db
            .prepare(
              "SELECT * FROM missions WHERE namespace=? ORDER BY created_at,mission_id",
            )
            .all(ns)
    ).map((r) => this.#decode(r));
  }
  events(ns, id) {
    this.#row(ns, id);
    return this.#db
      .prepare(
        "SELECT * FROM mission_events WHERE namespace=? AND mission_id=? ORDER BY event_id",
      )
      .all(ns, id)
      .map((r) => ({
        event_id: r.event_id,
        namespace: r.namespace,
        mission_id: r.mission_id,
        type: r.type,
        detail: JSON.parse(r.detail_json),
        created_at: r.created_at,
      }));
  }
  calls(ns, id) {
    this.#row(ns, id);
    return this.#db
      .prepare(
        "SELECT * FROM mission_calls WHERE namespace=? AND mission_id=? ORDER BY rowid",
      )
      .all(ns, id)
      .map((r) => ({
        attempt_id: r.attempt_id,
        phase: r.phase,
        packet: JSON.parse(r.packet_json),
        result: r.result_json ? JSON.parse(r.result_json) : null,
        error: r.error_json ? JSON.parse(r.error_json) : null,
        created_at: r.created_at,
        updated_at: r.updated_at,
      }));
  }
  _recordPacket(packet) {
    const t = this._time();
    this.#db
      .prepare(
        "INSERT INTO mission_calls(attempt_id,namespace,mission_id,phase,packet_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
      )
      .run(
        packet.attempt_id,
        packet.namespace,
        packet.goal_id,
        packet.step_id.slice(8),
        json(packet),
        t,
        t,
      );
  }
  _recordResult(packet, result) {
    this.#db
      .prepare(
        "UPDATE mission_calls SET result_json=?,updated_at=? WHERE attempt_id=?",
      )
      .run(json(result), this._time(), packet.attempt_id);
  }
  _recordError(packet, error) {
    this.#db
      .prepare(
        "UPDATE mission_calls SET error_json=?,updated_at=? WHERE attempt_id=?",
      )
      .run(
        json({
          code: error.code ?? "WORKER_ERROR",
          message: String(error.message ?? error).slice(0, 2000),
          notStarted: error.notStarted === true,
        }),
        this._time(),
        packet.attempt_id,
      );
  }
  pauseMission(ns, id) {
    return this.#tx(() => {
      const r = this.#row(ns, id);
      if (["completed", "cancelled"].includes(r.status))
        throw fault("INVALID_STATE", "Cannot pause a terminal mission");
      this.#db
        .prepare(
          "UPDATE missions SET resume_status=CASE WHEN status='paused' THEN resume_status ELSE status END,status='paused',updated_at=? WHERE namespace=? AND mission_id=?",
        )
        .run(this._time(), ns, id);
      this.#event(ns, id, "mission_paused", { in_flight_may_finish: true });
      return this.getMission(ns, id);
    });
  }
  resumeMission(ns, id) {
    return this.#tx(() => {
      const r = this.#row(ns, id);
      if (r.status !== "paused")
        throw fault("INVALID_STATE", "Only a paused mission may resume");
      this.#db
        .prepare(
          "UPDATE missions SET status=?,resume_status=NULL,updated_at=? WHERE namespace=? AND mission_id=?",
        )
        .run(r.resume_status ?? "active", this._time(), ns, id);
      this.#event(ns, id, "mission_resumed");
      return this.getMission(ns, id);
    });
  }
  cancelMission(ns, id) {
    return this.#tx(() => {
      this.#row(ns, id);
      this.#db
        .prepare(
          "UPDATE missions SET status='cancelled',lease_token=NULL,lease_until=NULL,updated_at=? WHERE namespace=? AND mission_id=?",
        )
        .run(this._time(), ns, id);
      this.#event(ns, id, "mission_cancelled", {
        in_flight_may_continue: true,
      });
      return this.getMission(ns, id);
    });
  }
  retryMission(ns, id) {
    return this.#tx(() => {
      const r = this.#row(ns, id),
        s = JSON.parse(r.contract_json);
      if (r.status !== "blocked")
        throw fault("INVALID_STATE", "Only a blocked mission may be retried");
      if (r.calls_reserved >= s.max_calls || r.cycle >= s.max_cycles)
        throw fault(
          "BUDGET_EXHAUSTED",
          "Mission call/cycle ceiling cannot be expanded by retry",
        );
      this.#db
        .prepare(
          "UPDATE missions SET status='active',phase='plan',plan_json=NULL,child_json=NULL,child_goal_id=NULL,blocked_reason=NULL,lease_token=NULL,lease_until=NULL,next_wake_at=NULL,updated_at=? WHERE namespace=? AND mission_id=?",
        )
        .run(this._time(), ns, id);
      this.#event(ns, id, "operator_retry", { read_only_only: true });
      return this.getMission(ns, id);
    });
  }
  _recover(ns) {
    return this.#tx(() => {
      let count = 0;
      for (const m of this.listMissions(ns)) {
        if (m.lease_until != null && m.lease_until <= this._time()) {
          this.#db
            .prepare(
              "UPDATE missions SET resume_status=CASE WHEN status='paused' THEN 'blocked' ELSE resume_status END,status=CASE WHEN status='paused' THEN 'paused' ELSE 'blocked' END,blocked_reason='LEASE_EXPIRED: reconcile previous phase before explicit retry',lease_token=NULL,lease_until=NULL,updated_at=? WHERE namespace=? AND mission_id=?",
            )
            .run(this._time(), m.namespace, m.mission_id);
          this.#event(m.namespace, m.mission_id, "lease_expired", {
            phase: m.phase,
            cycle: m.cycle,
          });
          count++;
        }
      }
      return count;
    });
  }
  _claim(ns, id, leaseMs) {
    return this.#tx(() => {
      let r = this.#row(ns, id),
        s = JSON.parse(r.contract_json),
        t = this._time();
      if (r.status === "maintenance" && r.next_wake_at <= t) {
        this.#db
          .prepare(
            "UPDATE missions SET status='active',phase='plan',plan_json=NULL,child_json=NULL,child_goal_id=NULL,next_wake_at=NULL WHERE namespace=? AND mission_id=?",
          )
          .run(ns, id);
        this.#event(ns, id, "maintenance_due");
        r = this.#row(ns, id);
      }
      if (
        r.status !== "active" ||
        r.lease_token ||
        (r.next_wake_at != null && r.next_wake_at > t)
      )
        return null;
      if (r.phase === "plan" && r.cycle >= s.max_cycles) {
        this._blocked(
          ns,
          id,
          "CYCLES_EXHAUSTED: user must review the objective, evidence or limits",
        );
        return null;
      }
      const cost = r.phase === "child" ? 0 : 1;
      if (r.calls_reserved + cost > s.max_calls) {
        this._blocked(
          ns,
          id,
          "BUDGET_EXHAUSTED: adapter invocation reservation ceiling reached",
        );
        return null;
      }
      const token = randomUUID(),
        cycle = r.phase === "plan" ? r.cycle + 1 : r.cycle;
      this.#db
        .prepare(
          "UPDATE missions SET next_wake_at=NULL,calls_reserved=calls_reserved+?,cycle=?,lease_token=?,lease_until=?,updated_at=? WHERE namespace=? AND mission_id=?",
        )
        .run(cost, cycle, token, t + leaseMs, t, ns, id);
      this.#event(ns, id, "phase_claimed", {
        phase: r.phase,
        cycle,
        attempt_id: token,
        calls_reserved: cost,
      });
      return { mission: this.getMission(ns, id), token, phase: r.phase };
    });
  }
  _blocked(ns, id, reason) {
    this.#db
      .prepare(
        "UPDATE missions SET resume_status=CASE WHEN status='paused' THEN 'blocked' ELSE resume_status END,status=CASE WHEN status='paused' THEN 'paused' ELSE 'blocked' END,blocked_reason=?,lease_token=NULL,lease_until=NULL,updated_at=? WHERE namespace=? AND mission_id=?",
      )
      .run(String(reason).slice(0, 2000), this._time(), ns, id);
    this.#event(ns, id, "mission_blocked", {
      reason: String(reason).slice(0, 2000),
    });
  }
  _fail(claim, error) {
    return this.#tx(() => {
      const m = this.#row(claim.mission.namespace, claim.mission.mission_id);
      if (m.lease_token !== claim.token) return false;
      if (error.notStarted === true && claim.phase !== "child") {
        this.#db
          .prepare(
            "UPDATE missions SET calls_reserved=calls_reserved-1,cycle=cycle-?,updated_at=? WHERE namespace=? AND mission_id=?",
          )
          .run(
            claim.phase === "plan" ? 1 : 0,
            this._time(),
            m.namespace,
            m.mission_id,
          );
        this.#event(m.namespace, m.mission_id, "reservation_refunded", {
          phase: claim.phase,
          reason: error.code ?? "NOT_STARTED",
        });
      }
      this._blocked(
        m.namespace,
        m.mission_id,
        `${error.code ?? "DIRECTOR_ERROR"}: ${error.message ?? error}`,
      );
      return true;
    });
  }
  _owns(claim) {
    const r = this.#row(claim.mission.namespace, claim.mission.mission_id);
    return (
      r.status === "active" &&
      r.lease_token === claim.token &&
      r.lease_until > this._time()
    );
  }
  _finish(claim, changes, event, detail = {}) {
    return this.#tx(() => {
      const ns = claim.mission.namespace,
        id = claim.mission.mission_id,
        r = this.#row(ns, id);
      if (r.lease_token !== claim.token || r.status === "cancelled")
        throw fault("STALE_ATTEMPT", "Mission phase no longer owns its lease");
      if (r.lease_until <= this._time())
        throw fault("STALE_ATTEMPT", "Mission phase exceeded its lease");
      if (r.status === "paused" && Object.hasOwn(changes, "status")) {
        changes = { ...changes, resume_status: changes.status };
        delete changes.status;
      }
      const allowed = [
        "resume_status",
        "phase",
        "status",
        "plan_json",
        "child_json",
        "child_goal_id",
        "observations_json",
        "blocked_reason",
        "next_wake_at",
        "calls_reserved",
      ];
      if (Object.keys(changes).some((k) => !allowed.includes(k)))
        throw fault("INVALID_INPUT", "Invalid mission transition");
      const keys = Object.keys(changes);
      this.#db
        .prepare(
          `UPDATE missions SET ${keys.map((k) => `${k}=?`).join(",")}${keys.length ? "," : ""}lease_token=NULL,lease_until=NULL,updated_at=? WHERE namespace=? AND mission_id=?`,
        )
        .run(...keys.map((k) => changes[k]), this._time(), ns, id);
      this.#event(ns, id, event, detail);
      return this.getMission(ns, id);
    });
  }
}

const identity = [
  "namespace",
  "goal_id",
  "goal_version",
  "step_id",
  "task_id",
  "input_sha256",
  "attempt_id",
];
function checkedResult(packet, result) {
  if (!result || typeof result !== "object" || Array.isArray(result))
    throw fault("INVALID_RESULT", "Expected a structured worker result");
  for (const k of identity)
    if (result[k] !== packet[k])
      throw fault(
        "RESULT_IDENTITY_MISMATCH",
        `Result ${k} does not match mission phase`,
      );
  if (result.producer !== packet.worker)
    throw fault("PRODUCER_MISMATCH", "Unexpected phase producer");
  strings(result.evidence, "evidence");
  if (packet.type === "review") {
    if (!["accept", "reject"].includes(result.decision))
      throw fault("INVALID_RESULT", "Review decision must be accept or reject");
  } else {
    if (!result.output || typeof result.output.summary !== "string")
      throw fault(
        "INVALID_RESULT",
        "Planner output.summary must contain a JSON plan",
      );
  }
  return JSON.parse(json(result));
}

export class MissionDirector {
  constructor({
    store,
    goalStore,
    workers,
    leaseMs = 300000,
    owner = randomUUID(),
  }) {
    if (!store || !goalStore || !workers)
      throw fault(
        "INVALID_CONFIG",
        "store, goalStore and workers are required",
      );
    integer(leaseMs, "leaseMs", 20, 3600000);
    Object.assign(this, { store, goalStore, workers, leaseMs, owner });
  }
  #worker(id) {
    return this.workers instanceof Map
      ? this.workers.get(id)
      : Object.hasOwn(this.workers, id)
        ? this.workers[id]
        : undefined;
  }
  #eligible(id, mission, capability) {
    const no = (code, message) => {
      throw Object.assign(fault(code, message), { notStarted: true });
    };
    const w = this.#worker(id);
    if (!w || !w.enabled || typeof w.run !== "function")
      no("WORKER_UNAVAILABLE", `Adapter ${id} is unavailable or disabled`);
    if (w.type === "demo" && mission.mode !== "demo")
      no(
        "DEMO_MODE_REQUIRED",
        "Demo adapters cannot establish completion of live missions",
      );
    if (w.effects !== "read-only")
      no(
        "WRITE_NOT_ALLOWED",
        "Autonomous missions in this release require read-only adapters",
      );
    if (!w.namespaces?.includes(mission.namespace))
      no(
        "NAMESPACE_DENIED",
        `Adapter ${id} is not authorized for ${mission.namespace}`,
      );
    if (
      !mission.grants.includes(capability) ||
      !w.capabilities?.some((c) => c === capability || c === "*")
    )
      no("GRANT_DENIED", `Adapter ${id} lacks approved ${capability}`);
    return w;
  }
  #packet(m, claim, type, input, result) {
    const worker = type === "task" ? m.planner : m.reviewer;
    const capability =
      type === "review"
        ? "review"
        : m.grants.find(
            (c) =>
              ["demo.plan", "repo.read", "document.read"].includes(c) &&
              this.#worker(worker)?.capabilities?.some(
                (v) => v === c || v === "*",
              ),
          );
    this.#eligible(worker, m, capability);
    const phase = claim.phase;
    const p = {
      protocol: "ciaomind.goal-worker.v1",
      type,
      namespace: m.namespace,
      goal_id: m.mission_id,
      goal_version: 1,
      step_id: `mission-${phase}`,
      task_id: `${m.namespace}/${m.mission_id}/mission-${phase}`,
      input_sha256: hash({
        mission_sha256: m.contract_sha256,
        phase,
        cycle: m.cycle,
        input,
        result: result ?? null,
      }),
      attempt_id: claim.token,
      worker,
      kind:
        type === "task"
          ? "mission-plan"
          : phase === "plan_review"
            ? "mission-plan"
            : "mission-review",
      capability,
      grant: { namespace: m.namespace, capability },
      dependencies: {},
      input,
      objective: m.objective,
      acceptance: m.acceptance,
      lease_until: m.lease_until,
      deadline: m.lease_until,
      idempotency_key: `${m.namespace}/${m.mission_id}/${m.cycle}/${phase}`,
    };
    if (result !== undefined) p.result = result;
    return p;
  }
  async #call(packet, signal) {
    const controller = new AbortController();
    let timer;
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    try {
      const timed = new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(
            fault("LEASE_TIMEOUT", "Mission adapter exceeded phase lease"),
          );
        }, this.leaseMs);
        controller.signal.addEventListener(
          "abort",
          () =>
            reject(
              fault("ABORTED", "Mission phase aborted; reconcile before retry"),
            ),
          { once: true },
        );
      });
      if (controller.signal.aborted)
        throw fault("ABORTED", "Mission phase cancelled before invocation");
      this.store._recordPacket(packet);
      try {
        const raw = await Promise.race([
          this.#worker(packet.worker).run(packet, {
            signal: controller.signal,
          }),
          timed,
        ]);
        this.store._recordResult(packet, raw);
        return checkedResult(packet, raw);
      } catch (error) {
        this.store._recordError(packet, error);
        throw error;
      }
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }
  #plan(m, result) {
    let p;
    try {
      p = JSON.parse(result.output.summary);
    } catch {
      throw fault("INVALID_PLAN", "Planner summary is not JSON");
    }
    if (
      !p ||
      Array.isArray(p) ||
      Object.keys(p).some((k) => k !== "steps") ||
      !Array.isArray(p.steps) ||
      !p.steps.length ||
      p.steps.length > 8
    )
      throw fault("INVALID_PLAN", "Plan must contain only 1–8 steps");
    for (const s of p.steps) {
      if (
        !m.allowed_workers.includes(s.worker) ||
        !m.allowed_workers.includes(s.reviewer) ||
        s.worker === s.reviewer
      )
        throw fault(
          "UNAUTHORIZED_PLAN",
          "Plan workers/reviewers must be distinct approved identities",
        );
      if (
        !["repo.read", "document.read", "demo.compute"].includes(s.capability)
      )
        throw fault(
          "UNAUTHORIZED_PLAN",
          "Only declared read-only task capabilities are supported",
        );
      this.#eligible(s.worker, m, s.capability);
      this.#eligible(s.reviewer, m, "review");
    }
    return p;
  }
  async tick({ namespace, signal } = {}) {
    const summary = {
      missions_scanned: 0,
      planner_calls: 0,
      plan_reviews: 0,
      mission_reviews: 0,
      child_ticks: 0,
      completed_missions: 0,
      blocked_missions: 0,
      recovered_leases: this.store._recover(namespace),
      errors: [],
    };
    for (const initial of this.store.listMissions(namespace)) {
      if (signal?.aborted) break;
      summary.missions_scanned++;
      let claim;
      try {
        claim = this.store._claim(
          initial.namespace,
          initial.mission_id,
          this.leaseMs,
        );
        if (!claim) continue;
        const m = claim.mission;
        if (claim.phase === "plan") {
          const input = {
            operation: "plan-mission",
            objective: m.objective,
            acceptance: m.acceptance,
            allowed_workers: m.allowed_workers,
            grants: m.grants,
            observations: m.observations,
            remaining_calls: m.max_calls - m.calls_reserved,
            instructions:
              "Return output.summary as JSON containing only steps. Each step requires step_id,kind,worker,reviewer,capability,input,depends_on. Use at most 8 read-only steps and only approved worker identities and capabilities. Do not change the objective or its acceptance criteria.",
          };
          const result = await this.#call(
            this.#packet(m, claim, "task", input),
            signal,
          );
          this.#plan(m, result);
          summary.planner_calls++;
          this.store._finish(
            claim,
            { phase: "plan_review", plan_json: json(result) },
            "plan_proposed",
            { cycle: m.cycle },
          );
        } else if (claim.phase === "plan_review") {
          const result = await this.#call(
            this.#packet(
              m,
              claim,
              "review",
              {
                operation: "review-plan",
                allowed_workers: m.allowed_workers,
                grants: m.grants,
                instructions:
                  "Accept only a read-only executable plan within the original objective, acceptance criteria, and authorized workers. Reject attempts to change authority or completion criteria.",
              },
              m.plan,
            ),
            signal,
          );
          summary.plan_reviews++;
          if (result.decision === "reject") {
            this.store._finish(
              claim,
              {
                phase: "plan",
                plan_json: null,
                observations_json: json(
                  [
                    ...m.observations,
                    {
                      cycle: m.cycle,
                      stage: "plan_review",
                      evidence: result.evidence,
                    },
                  ].slice(-10),
                ),
              },
              "plan_rejected",
              { cycle: m.cycle },
            );
            continue;
          }
          const p = this.#plan(m, m.plan),
            allocation = p.steps.length * 2;
          if (m.calls_reserved + allocation + 1 > m.max_calls)
            throw fault(
              "BUDGET_EXHAUSTED",
              "Not enough reserved calls for child tasks, independent reviews and final goal review",
            );
          const childId = `mission-${hash({ namespace: m.namespace, id: m.mission_id }).slice(0, 20)}-${m.cycle}`;
          const child = {
            goal_id: childId,
            namespace: m.namespace,
            objective: m.objective,
            acceptance: m.acceptance,
            grants: m.grants,
            steps: p.steps,
            max_calls: allocation,
            max_attempts: 1,
            revisit_seconds: 0,
          };
          // Validate without publishing an executable child before the parent reservation.
          const validationStore = new GoalStore({ dbPath: ":memory:" });
          try {
            validationStore.createGoal(child);
          } finally {
            validationStore.close();
          }
          this.store._finish(
            claim,
            {
              phase: "child",
              child_json: json(child),
              child_goal_id: childId,
              calls_reserved: m.calls_reserved + allocation,
            },
            "plan_accepted",
            {
              cycle: m.cycle,
              child_goal_id: childId,
              child_calls_reserved: allocation,
            },
          );
        } else if (claim.phase === "child") {
          this.goalStore.createGoal(m.child_goal);
          // Scope a tick to this child: another paused mission must not be advanced.
          const goalStore = this.goalStore,
            missionStore = this.store;
          const scoped = new Proxy(goalStore, {
            get(target, key) {
              if (key === "listGoals")
                return () => [target.getGoal(m.namespace, m.child_goal_id)];
              if (key === "_claim")
                return (...args) =>
                  missionStore._owns(claim) ? target._claim(...args) : null;
              const value = Reflect.get(target, key, target);
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
          const coordinator = new Coordinator({
            store: scoped,
            workers: this.workers,
            owner: this.owner,
            leaseMs: Math.max(
              10,
              this.leaseMs - Math.min(1000, Math.floor(this.leaseMs / 4)),
            ),
            maxActionsPerTick: 1,
          });
          await coordinator.tick({ namespace: m.namespace, signal });
          summary.child_ticks++;
          const child = this.goalStore.getGoal(m.namespace, m.child_goal_id);
          if (child.status === "completed")
            this.store._finish(
              claim,
              { phase: "final_review" },
              "child_completed",
              { child_goal_id: m.child_goal_id },
            );
          else if (child.status === "blocked") {
            this.store._finish(
              claim,
              {
                phase: "plan",
                child_json: null,
                child_goal_id: null,
                plan_json: null,
                observations_json: json(
                  [
                    ...m.observations,
                    {
                      cycle: m.cycle,
                      stage: "child_blocked",
                      reason: child.blocked_reason,
                      steps: child.steps.map((s) => ({
                        step_id: s.step_id,
                        status: s.status,
                        blocked_reason: s.blocked_reason,
                      })),
                    },
                  ].slice(-10),
                ),
              },
              "child_requires_replan",
              { child_goal_id: m.child_goal_id },
            );
          } else
            this.store._finish(claim, {}, "child_waiting", {
              child_goal_id: m.child_goal_id,
              status: child.status,
            });
        } else if (claim.phase === "final_review") {
          const child = this.goalStore.getGoal(m.namespace, m.child_goal_id);
          const result = await this.#call(
            this.#packet(
              m,
              claim,
              "review",
              {
                operation: "evaluate-mission",
                instructions:
                  "Accept only if the evidence from the completed child goal satisfies the ORIGINAL mission objective and acceptance criteria. Completed steps alone are not sufficient. Reject and explain missing evidence if the target is not met.",
              },
              child,
            ),
            signal,
          );
          summary.mission_reviews++;
          if (result.decision === "accept") {
            this.store._finish(
              claim,
              {
                status: m.revisit_seconds ? "maintenance" : "completed",
                phase: "plan",
                next_wake_at: m.revisit_seconds
                  ? this.store._time() + m.revisit_seconds * 1000
                  : null,
                observations_json: json(
                  [
                    ...m.observations,
                    {
                      cycle: m.cycle,
                      stage: "goal_accepted",
                      evidence: result.evidence,
                    },
                  ].slice(-10),
                ),
              },
              "mission_accepted",
              { cycle: m.cycle, next_check_seconds: m.revisit_seconds },
            );
            summary.completed_missions++;
          } else
            this.store._finish(
              claim,
              {
                phase: "plan",
                plan_json: null,
                child_json: null,
                child_goal_id: null,
                observations_json: json(
                  [
                    ...m.observations,
                    {
                      cycle: m.cycle,
                      stage: "goal_rejected",
                      evidence: result.evidence,
                    },
                  ].slice(-10),
                ),
              },
              "mission_requires_replan",
              { cycle: m.cycle },
            );
        } else throw fault("INVALID_STATE", "Unknown mission phase");
      } catch (e) {
        if (claim) {
          const current = this.store.getMission(
            initial.namespace,
            initial.mission_id,
          );
          if (
            ["INVALID_PLAN", "INVALID_INPUT", "INVALID_RESULT"].includes(
              e.code,
            ) &&
            ["plan", "plan_review"].includes(claim.phase) &&
            e.notStarted !== true &&
            this.store._owns(claim) &&
            current.cycle < current.max_cycles &&
            current.calls_reserved < current.max_calls
          ) {
            this.store._finish(
              claim,
              {
                phase: "plan",
                plan_json: null,
                next_wake_at: this.store._time() + 1000,
                observations_json: json(
                  [
                    ...current.observations,
                    {
                      cycle: current.cycle,
                      stage: "planning_error",
                      code: e.code,
                      message: String(e.message).slice(0, 1000),
                    },
                  ].slice(-10),
                ),
              },
              "plan_needs_repair",
              { cycle: current.cycle, code: e.code },
            );
          } else this.store._fail(claim, e);
        }
        summary.errors.push({
          namespace: initial.namespace,
          mission_id: initial.mission_id,
          code: e.code ?? "DIRECTOR_ERROR",
        });
      }
    }
    summary.blocked_missions = this.store
      .listMissions(namespace)
      .filter((m) => m.status === "blocked").length;
    return summary;
  }
}
