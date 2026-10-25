import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GoalStore, fault } from "./store.mjs";
import { Coordinator } from "./engine.mjs";

const identity = (packet) =>
  Object.fromEntries(
    [
      "namespace",
      "goal_id",
      "goal_version",
      "step_id",
      "task_id",
      "input_sha256",
      "attempt_id",
    ].map((key) => [key, packet[key]]),
  );
const response = (packet) =>
  packet.type === "review"
    ? {
        ...identity(packet),
        producer: packet.worker,
        decision: "accept",
        evidence: [
          "Independent demo worker checked the supplied synthetic result",
        ],
      }
    : {
        ...identity(packet),
        producer: packet.worker,
        output: {
          sum: (packet.input.values ?? []).reduce((a, b) => a + b, 0),
          dependencies: packet.dependencies,
        },
        evidence: [
          "Local deterministic synthetic worker; not a model or vendor authentication",
        ],
      };
const worker = (id, run = response, effects = "read-only") => ({
  id,
  enabled: true,
  effects,
  capabilities: ["demo.compute", "review"],
  namespaces: ["project", "personal"],
  run,
});
const registry = () => ({
  producer: worker("producer"),
  auditor: worker("auditor"),
});
const contract = (extra = {}) => ({
  namespace: "project",
  goal_id: "synthetic",
  objective: "Sum synthetic values with independent review",
  acceptance: ["Output has the expected integer sum"],
  grants: ["demo.compute", "review"],
  max_calls: 10,
  max_attempts: 3,
  revisit_seconds: 0,
  steps: [
    {
      step_id: "one",
      kind: "research",
      worker: "producer",
      reviewer: "auditor",
      capability: "demo.compute",
      input: { values: [3, 5, 8] },
      depends_on: [],
    },
  ],
  ...extra,
});
function fixture(t, { time = 10000, file = false } = {}) {
  let clock = time;
  const dir = file ? mkdtempSync(join(tmpdir(), "goal-engine-test-")) : null;
  const dbPath = dir ? join(dir, "state.sqlite") : ":memory:";
  const store = new GoalStore({ dbPath, now: () => clock });
  t.after(() => {
    store.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });
  return {
    store,
    dbPath,
    now: () => clock,
    setTime: (value) => {
      clock = value;
    },
    advance: (value) => {
      clock += value;
    },
  };
}

test("immutable contracts, namespaces and DAG validation preserve durable identities", (t) => {
  const f = fixture(t, { file: true });
  const value = f.store.createGoal(contract());
  assert.deepEqual(f.store.createGoal(contract()), value);
  assert.throws(() => f.store.createGoal(contract({ objective: "changed" })), {
    code: "INPUT_CONFLICT",
  });
  f.store.createGoal(contract({ namespace: "personal" }));
  assert.equal(f.store.listGoals("project").length, 1);
  assert.equal(f.store.listGoals("personal").length, 1);
  assert.throws(
    () =>
      f.store.createGoal(
        contract({
          goal_id: "cycle",
          steps: [
            { step_id: "a", worker: "producer", depends_on: ["b"] },
            { step_id: "b", worker: "producer", depends_on: ["a"] },
          ],
        }),
      ),
    { code: "INVALID_INPUT" },
  );
  assert.equal(f.store.listGoals().length, 2);
  const reopened = new GoalStore({ dbPath: f.dbPath });
  try {
    assert.equal(
      reopened.getGoal("project", "synthetic").contract_sha256,
      value.contract_sha256,
    );
  } finally {
    reopened.close();
  }
});

test("one tick advances explicit dependencies through distinct worker and reviewer", async (t) => {
  const f = fixture(t);
  const calls = [];
  const workers = registry();
  workers.producer.run = (p) => {
    calls.push(p);
    return response(p);
  };
  const base = contract();
  base.steps.push({
    ...base.steps[0],
    step_id: "two",
    input: { values: [1, 2] },
    depends_on: ["one"],
  });
  f.store.createGoal(base);
  const summary = await new Coordinator({ store: f.store, workers }).tick();
  const goal = f.store.getGoal("project", "synthetic");
  assert.equal(goal.status, "completed");
  assert.equal(goal.calls_reserved, 4);
  assert.equal(summary.completed_steps, 2);
  assert.equal(goal.steps[0].result.output.sum, 16);
  assert.equal(goal.steps[1].result.output.sum, 3);
  assert.deepEqual(calls[1].dependencies.one, { sum: 16, dependencies: {} });
  assert.equal(
    f.store
      .events("project", "synthetic")
      .filter((e) => e.type === "independent_review").length,
    2,
  );
  await new Coordinator({ store: f.store, workers }).tick();
  assert.equal(calls.length, 2);
});

test("missing registry and namespace authorization block without consuming calls", async (t) => {
  const f = fixture(t);
  f.store.createGoal(contract());
  const workers = registry();
  workers.producer.namespaces = ["personal"];
  const engine = new Coordinator({ store: f.store, workers });
  await engine.tick({ namespace: "project" });
  let goal = f.store.getGoal("project", "synthetic");
  assert.equal(goal.status, "blocked");
  assert.match(goal.steps[0].blocked_reason, /NAMESPACE_DENIED/);
  assert.equal(goal.calls_reserved, 0);
  workers.producer.namespaces = ["project"];
  await engine.tick();
  assert.equal(f.store.getGoal("project", "synthetic").status, "completed");
});

test("grants and self review are checked independently of the model", async (t) => {
  const f = fixture(t);
  f.store.createGoal(contract({ grants: ["review"] }));
  await new Coordinator({ store: f.store, workers: registry() }).tick();
  assert.equal(f.store.getGoal("project", "synthetic").calls_reserved, 0);
  assert.match(
    f.store.getGoal("project", "synthetic").blocked_reason,
    /GRANT_DENIED/,
  );
  const self = contract({ goal_id: "self" });
  self.steps[0].reviewer = "producer";
  f.store.createGoal(self);
  await new Coordinator({ store: f.store, workers: registry() }).tick();
  const goal = f.store.getGoal("project", "self");
  assert.notEqual(goal.status, "completed");
  assert.equal(goal.calls_reserved, 1);
  assert.match(goal.steps[0].blocked_reason, /SELF_REVIEW/);
});

test("persistent reservation budget includes independent review and prevents overrun", async (t) => {
  const f = fixture(t, { file: true });
  f.store.createGoal(contract({ max_calls: 1 }));
  await new Coordinator({ store: f.store, workers: registry() }).tick();
  const goal = f.store.getGoal("project", "synthetic");
  assert.equal(goal.calls_reserved, 1);
  assert.equal(goal.steps[0].result.output.sum, 16);
  assert.match(goal.steps[0].blocked_reason, /BUDGET_EXHAUSTED/);
  assert.notEqual(goal.status, "completed");
  const again = new GoalStore({ dbPath: f.dbPath });
  try {
    await new Coordinator({ store: again, workers: registry() }).tick();
    assert.equal(again.getGoal("project", "synthetic").calls_reserved, 1);
  } finally {
    again.close();
  }
});

test("wrong input fingerprint cannot become a result or pass review", async (t) => {
  const f = fixture(t);
  f.store.createGoal(contract());
  const workers = registry();
  workers.producer.run = (p) => ({ ...response(p), input_sha256: "wrong" });
  const summary = await new Coordinator({ store: f.store, workers }).tick();
  const goal = f.store.getGoal("project", "synthetic");
  assert.equal(goal.steps[0].result, null);
  assert.match(goal.steps[0].blocked_reason, /RESULT_MISMATCH/);
  assert.equal(summary.review_calls, 0);
});

test("read-only retry is bounded and waits for persisted backoff", async (t) => {
  const f = fixture(t);
  f.store.createGoal(contract());
  const workers = registry();
  let calls = 0;
  workers.producer.run = (p) => {
    if (++calls === 1) {
      const error = fault("TEMPORARY", "Synthetic temporary failure");
      error.retryable = true;
      throw error;
    }
    return response(p);
  };
  const engine = new Coordinator({ store: f.store, workers });
  await engine.tick();
  assert.equal(calls, 1);
  assert.equal(
    f.store.getGoal("project", "synthetic").steps[0].status,
    "pending",
  );
  await engine.tick();
  assert.equal(calls, 1);
  f.advance(1000);
  await engine.tick();
  assert.equal(calls, 2);
  assert.equal(f.store.getGoal("project", "synthetic").status, "completed");
  assert.equal(f.store.getGoal("project", "synthetic").calls_reserved, 3);
});

test("an unavailable credential returns reservations and stays blocked until explicit retry", async (t) => {
  const f = fixture(t);
  f.store.createGoal(contract());
  const workers = registry();
  workers.producer.run = () => {
    const error = fault(
      "AUTH_REQUIRED",
      "Authenticate using the official local CLI",
    );
    error.notStarted = true;
    throw error;
  };
  const engine = new Coordinator({ store: f.store, workers });
  await engine.tick();
  let goal = f.store.getGoal("project", "synthetic");
  assert.equal(goal.calls_reserved, 0);
  assert.equal(goal.steps[0].attempts, 0);
  assert.match(goal.blocked_reason, /AUTH_REQUIRED/);
  workers.producer.run = response;
  await engine.tick();
  assert.equal(f.store.getGoal("project", "synthetic").status, "blocked");
  f.store.retryBlocked("project", "synthetic");
  await engine.tick();
  assert.equal(f.store.getGoal("project", "synthetic").status, "completed");
});

test("two coordinators cannot claim the same in-flight step", async (t) => {
  const f = fixture(t);
  f.store.createGoal(contract());
  const workers = registry();
  let release,
    calls = 0;
  workers.producer.run = (p) => {
    calls++;
    return new Promise((resolve) => {
      release = () => resolve(response(p));
    });
  };
  const first = new Coordinator({
    store: f.store,
    workers,
    owner: "first",
  }).tick();
  await new Promise((resolve) => setImmediate(resolve));
  const second = await new Coordinator({
    store: f.store,
    workers,
    owner: "second",
  }).tick();
  assert.equal(calls, 1);
  assert.equal(second.task_calls, 0);
  release();
  await first;
  assert.equal(f.store.getGoal("project", "synthetic").status, "completed");
});

test("read-only expired leases recover after restart; late old results cannot overwrite", async (t) => {
  const f = fixture(t, { file: true });
  f.store.createGoal(contract());
  const workers = registry();
  let release,
    calls = 0;
  workers.producer.run = (p) => {
    calls++;
    if (calls === 1)
      return new Promise((resolve) => {
        release = () => resolve(response(p));
      });
    return response(p);
  };
  const a = new Coordinator({
    store: f.store,
    workers,
    owner: "old",
    leaseMs: 100000,
  }).tick();
  await new Promise((resolve) => setImmediate(resolve));
  f.advance(100001);
  const second = new GoalStore({ dbPath: f.dbPath, now: f.now });
  try {
    const b = new Coordinator({
      store: second,
      workers,
      owner: "new",
      leaseMs: 100000,
    });
    const recovered = await b.tick();
    assert.equal(recovered.recovered_leases, 1);
    assert.equal(calls, 1);
    f.advance(1000);
    await b.tick();
    const goal = second.getGoal("project", "synthetic");
    assert.equal(goal.status, "completed");
    assert.equal(goal.calls_reserved, 3);
    release();
    await a;
    assert.deepEqual(
      second.getGoal("project", "synthetic").steps[0].result,
      goal.steps[0].result,
    );
  } finally {
    second.close();
  }
});

test("expired writes become uncertain and never repeat automatically", async (t) => {
  const f = fixture(t);
  f.store.createGoal(contract());
  const workers = registry();
  let release,
    calls = 0;
  workers.producer.effects = "write";
  workers.producer.run = (p) => {
    calls++;
    return new Promise((resolve) => {
      release = () => resolve(response(p));
    });
  };
  const a = new Coordinator({
    store: f.store,
    workers,
    leaseMs: 100000,
  }).tick();
  await new Promise((resolve) => setImmediate(resolve));
  f.advance(100001);
  await new Coordinator({ store: f.store, workers }).tick();
  assert.equal(calls, 1);
  assert.match(
    f.store.getGoal("project", "synthetic").steps[0].blocked_reason,
    /UNCERTAIN/,
  );
  assert.throws(() => f.store.retryBlocked("project", "synthetic"), {
    code: "OUTCOME_UNCERTAIN",
  });
  release();
  await a;
  assert.notEqual(f.store.getGoal("project", "synthetic").status, "completed");
});

test("namespace-scoped tick neither claims nor recovers another namespace lease", async (t) => {
  const f = fixture(t);
  f.store.createGoal(contract());
  f.store.createGoal(contract({ namespace: "personal" }));
  const workers = registry();
  let release;
  workers.producer.run = (p) =>
    p.namespace === "personal"
      ? new Promise((resolve) => {
          release = () => resolve(response(p));
        })
      : response(p);
  const personalRun = new Coordinator({
    store: f.store,
    workers,
    leaseMs: 100000,
  }).tick({ namespace: "personal" });
  await new Promise((resolve) => setImmediate(resolve));
  f.advance(100001);
  const projectTick = await new Coordinator({ store: f.store, workers }).tick({
    namespace: "project",
  });
  assert.equal(projectTick.goals_scanned, 1);
  assert.equal(projectTick.recovered_leases, 0);
  assert.equal(f.store.getGoal("project", "synthetic").status, "completed");
  assert.equal(
    f.store.getGoal("personal", "synthetic").steps[0].status,
    "running",
  );
  f.store.cancelGoal("personal", "synthetic");
  release();
  await personalRun;
});

test("pause preserves in-flight result but prevents review until resume", async (t) => {
  const f = fixture(t);
  f.store.createGoal(contract());
  const workers = registry();
  let release;
  workers.producer.run = (p) =>
    new Promise((resolve) => {
      release = () => resolve(response(p));
    });
  const engine = new Coordinator({ store: f.store, workers });
  const run = engine.tick();
  await new Promise((resolve) => setImmediate(resolve));
  f.store.pauseGoal("project", "synthetic");
  release();
  await run;
  let goal = f.store.getGoal("project", "synthetic");
  assert.equal(goal.status, "paused");
  assert.equal(goal.steps[0].status, "review");
  assert.equal(goal.calls_reserved, 1);
  f.store.resumeGoal("project", "synthetic");
  await engine.tick();
  assert.equal(f.store.getGoal("project", "synthetic").status, "completed");
});

test("cancel invalidates the active lease and ignores a late result", async (t) => {
  const f = fixture(t);
  f.store.createGoal(contract());
  const workers = registry();
  let release;
  workers.producer.run = (p) =>
    new Promise((resolve) => {
      release = () => resolve(response(p));
    });
  const run = new Coordinator({ store: f.store, workers }).tick();
  await new Promise((resolve) => setImmediate(resolve));
  f.store.cancelGoal("project", "synthetic");
  release();
  await run;
  const goal = f.store.getGoal("project", "synthetic");
  assert.equal(goal.status, "cancelled");
  assert.equal(goal.steps[0].result, null);
});

test("read-only maintenance reruns the explicit plan, changes fingerprints, and retains budget", async (t) => {
  const f = fixture(t);
  f.store.createGoal(contract({ max_calls: 4, revisit_seconds: 1 }));
  const engine = new Coordinator({ store: f.store, workers: registry() });
  await engine.tick();
  const original = f.store.getGoal("project", "synthetic");
  assert.equal(original.status, "maintenance");
  assert.equal(original.calls_reserved, 2);
  await engine.tick();
  assert.equal(f.store.getGoal("project", "synthetic").calls_reserved, 2);
  f.advance(1000);
  await engine.tick();
  const second = f.store.getGoal("project", "synthetic");
  assert.equal(second.cycle, 1);
  assert.equal(second.status, "maintenance");
  assert.equal(second.calls_reserved, 4);
  assert.notEqual(second.steps[0].input_sha256, original.steps[0].input_sha256);
  const history = f.store.calls("project", "synthetic");
  assert.equal(history.length, 4);
  assert.ok(history.every((call) => call.status === "completed"));
  assert.ok(
    history.some(
      (call) => call.result?.input_sha256 === original.steps[0].input_sha256,
    ),
  );
  assert.ok(
    history.some(
      (call) => call.result?.input_sha256 === second.steps[0].input_sha256,
    ),
  );
  f.advance(1000);
  await engine.tick();
  assert.match(
    f.store.getGoal("project", "synthetic").blocked_reason,
    /BUDGET_EXHAUSTED/,
  );
  assert.equal(f.store.getGoal("project", "synthetic").calls_reserved, 4);
});

test("maintenance never repeats historical writes even after a read-only review", async (t) => {
  const f = fixture(t);
  f.store.createGoal(contract({ revisit_seconds: 1 }));
  const workers = registry();
  workers.producer.effects = "write";
  const engine = new Coordinator({ store: f.store, workers });
  await engine.tick();
  assert.equal(f.store.getGoal("project", "synthetic").status, "maintenance");
  f.advance(1000);
  await engine.tick();
  const goal = f.store.getGoal("project", "synthetic");
  assert.equal(goal.calls_reserved, 2);
  assert.match(goal.blocked_reason, /MAINTENANCE_WRITE_DENIED/);
});

test("maintenance waits on infrastructure then resumes read-only checks at its next wake", async (t) => {
  const f = fixture(t);
  f.store.createGoal(contract({ revisit_seconds: 1 }));
  const workers = registry();
  const engine = new Coordinator({ store: f.store, workers });
  await engine.tick();
  workers.producer.enabled = false;
  f.advance(1000);
  await engine.tick();
  let goal = f.store.getGoal("project", "synthetic");
  assert.equal(goal.status, "maintenance");
  assert.match(goal.blocked_reason, /WORKER_DISABLED/);
  assert.equal(goal.calls_reserved, 2);
  workers.producer.enabled = true;
  await engine.tick();
  assert.equal(f.store.getGoal("project", "synthetic").calls_reserved, 2);
  f.advance(1000);
  await engine.tick();
  goal = f.store.getGoal("project", "synthetic");
  assert.equal(goal.status, "maintenance");
  assert.equal(goal.calls_reserved, 4);
  assert.equal(goal.cycle, 1);
});

test("only an explicit trusted preflight marker refunds a call reservation", async (t) => {
  const f = fixture(t);
  f.store.createGoal(contract());
  const workers = registry();
  workers.producer.run = () => {
    const error = fault("BINARY_MISSING", "No process was started");
    error.notStarted = true;
    throw error;
  };
  const summary = await new Coordinator({ store: f.store, workers }).tick();
  assert.equal(summary.task_calls, 0);
  assert.equal(f.store.getGoal("project", "synthetic").calls_reserved, 0);
  f.store.createGoal(contract({ goal_id: "post-start" }));
  workers.producer.run = () => {
    const error = fault("AUTH_REQUIRED", "A process was already invoked");
    error.notStarted = false;
    throw error;
  };
  await new Coordinator({ store: f.store, workers }).tick();
  assert.equal(f.store.getGoal("project", "post-start").calls_reserved, 1);
});

test("timeout on an uncertain write is persisted immediately without a dangling active lease", async (t) => {
  const f = fixture(t);
  f.store.createGoal(contract());
  const workers = registry();
  workers.producer.effects = "write";
  workers.producer.run = () => new Promise(() => {});
  await new Coordinator({ store: f.store, workers, leaseMs: 10 }).tick();
  const goal = f.store.getGoal("project", "synthetic");
  assert.equal(goal.steps[0].status, "blocked");
  assert.equal(goal.steps[0].lease_until, null);
  assert.match(goal.steps[0].blocked_reason, /OUTCOME_UNCERTAIN/);
});

test("abort signal stops new claims and schedules bounded recovery of read-only work", async (t) => {
  const f = fixture(t);
  f.store.createGoal(contract());
  const workers = registry();
  workers.producer.run = () => new Promise(() => {});
  const abort = new AbortController();
  const engine = new Coordinator({ store: f.store, workers });
  const pending = engine.tick({ signal: abort.signal });
  await new Promise((resolve) => setImmediate(resolve));
  abort.abort();
  await pending;
  const goal = f.store.getGoal("project", "synthetic");
  assert.equal(goal.steps[0].status, "pending");
  assert.equal(goal.steps[0].result, null);
  const again = await engine.tick({ signal: abort.signal });
  assert.equal(again.task_calls, 0);
});
