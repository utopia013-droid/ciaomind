import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MissionStore, MissionDirector } from "./core.mjs";
import { GoalStore } from "../orchestrator/store.mjs";

const keys = [
  "namespace",
  "goal_id",
  "goal_version",
  "step_id",
  "task_id",
  "input_sha256",
  "attempt_id",
];
const echo = (p) => Object.fromEntries(keys.map((k) => [k, p[k]]));
const plan = () => ({
  steps: [
    {
      step_id: "compute",
      kind: "research",
      worker: "worker",
      reviewer: "reviewer",
      capability: "repo.read",
      input: { operation: "sum", values: [3, 5, 8] },
      depends_on: [],
    },
  ],
});
const input = (extra = {}) => ({
  mission_id: "M1",
  namespace: "project",
  objective: "Verify synthetic total 16 without prescribing execution steps",
  acceptance: ["Independent evidence proves the total is 16"],
  grants: ["repo.read", "review"],
  planner: "planner",
  reviewer: "reviewer",
  allowed_workers: ["worker", "reviewer"],
  max_calls: 15,
  max_cycles: 3,
  revisit_seconds: 0,
  ...extra,
});
function fakeWorkers({
  planValue = plan,
  decide = () => "accept",
  hook,
  wrongHash = false,
} = {}) {
  const counts = { planner: 0, worker: 0, planReview: 0, finalReview: 0 };
  const adapter = (id, run) => ({
    id,
    type: "test",
    enabled: true,
    namespaces: ["project"],
    effects: "read-only",
    capabilities: ["repo.read", "review"],
    run,
  });
  const result = (p, extra) => ({
    ...echo(p),
    producer: p.worker,
    evidence: ["Synthetic fixed test calculation; no remote model"],
    ...extra,
  });
  const workers = {
    planner: adapter("planner", async (p) => {
      counts.planner++;
      if (hook) await hook(p);
      return result(p, {
        input_sha256: wrongHash ? "wrong" : p.input_sha256,
        output: { summary: JSON.stringify(planValue()), artifacts: [] },
      });
    }),
    worker: adapter("worker", async (p) => {
      counts.worker++;
      return result(p, {
        output: {
          summary: JSON.stringify({
            sum: p.input.values.reduce((a, b) => a + b, 0),
          }),
          artifacts: [],
        },
      });
    }),
    reviewer: adapter("reviewer", async (p) => {
      if (p.input.operation === "review-plan") counts.planReview++;
      if (p.input.operation === "evaluate-mission") counts.finalReview++;
      return result(p, { decision: decide(p, counts) });
    }),
  };
  return { workers, counts };
}
function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), "mission-test-"));
  let now = 1000000;
  let store = new MissionStore({
    dbPath: join(directory, "missions.sqlite"),
    now: () => now,
  });
  let goalStore = new GoalStore({
    dbPath: join(directory, "goals.sqlite"),
    now: () => now,
  });
  const { workers, counts } = fakeWorkers(options);
  let director = new MissionDirector({
    store,
    goalStore,
    workers,
    leaseMs: 5000,
  });
  t.after(() => {
    store.close();
    goalStore.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    workers,
    counts,
    get store() {
      return store;
    },
    get goalStore() {
      return goalStore;
    },
    get director() {
      return director;
    },
    advance: (n) => {
      now += n;
    },
    reopen() {
      store.close();
      goalStore.close();
      store = new MissionStore({
        dbPath: join(directory, "missions.sqlite"),
        now: () => now,
      });
      goalStore = new GoalStore({
        dbPath: join(directory, "goals.sqlite"),
        now: () => now,
      });
      director = new MissionDirector({
        store,
        goalStore,
        workers,
        leaseMs: 5000,
      });
    },
    async run(n = 12) {
      for (let i = 0; i < n; i++) {
        await director.tick();
        now += 1100;
        const m = store.getMission("project", "M1");
        if (["completed", "blocked", "maintenance"].includes(m.status))
          return m;
      }
      return store.getMission("project", "M1");
    },
  };
}

test("natural objective autonomously plans, executes and independently verifies goal completion", async (t) => {
  const f = fixture(t);
  const m = f.store.createMission(input());
  assert.equal(m.phase, "plan");
  assert.equal(m.plan, null);
  const done = await f.run();
  assert.equal(done.status, "completed");
  assert.equal(done.calls_reserved, 5);
  assert.deepEqual(f.counts, {
    planner: 1,
    worker: 1,
    planReview: 1,
    finalReview: 1,
  });
  assert.ok(
    f.store.events("project", "M1").some((e) => e.type === "mission_accepted"),
  );
  assert.throws(() => f.store.createMission(input({ objective: "changed" })), {
    code: "INPUT_CONFLICT",
  });
  assert.equal(f.store.createMission(input()).status, "completed");
});

test("child outbox reservation survives restart before child is published", async (t) => {
  const f = fixture(t);
  f.store.createMission(input());
  await f.director.tick();
  await f.director.tick();
  const staged = f.store.getMission("project", "M1");
  assert.equal(staged.phase, "child");
  assert.equal(staged.calls_reserved, 4);
  assert.equal(f.goalStore.listGoals().length, 0);
  f.reopen();
  const done = await f.run();
  assert.equal(done.status, "completed");
  assert.equal(f.counts.planner, 1);
  assert.equal(f.counts.worker, 1);
  assert.equal(f.goalStore.listGoals().length, 1);
});

test("goal rejection causes bounded replanning with evidence and immutable acceptance", async (t) => {
  const f = fixture(t, {
    decide: (p, c) =>
      p.input.operation === "evaluate-mission" && c.finalReview === 1
        ? "reject"
        : "accept",
  });
  f.store.createMission(input({ max_calls: 10, max_cycles: 2 }));
  const done = await f.run(15);
  assert.equal(done.status, "completed");
  assert.equal(done.cycle, 2);
  assert.equal(done.calls_reserved, 10);
  assert.equal(f.counts.planner, 2);
  assert.equal(f.goalStore.listGoals().length, 2);
  assert.ok(done.observations.some((o) => o.stage === "goal_rejected"));
  assert.deepEqual(done.acceptance, input().acceptance);
});

test("plan rejection may replan but cannot exceed maximum cycles", async (t) => {
  const f = fixture(t, {
    decide: (p) => (p.input.operation === "review-plan" ? "reject" : "accept"),
  });
  f.store.createMission(input({ max_cycles: 2 }));
  const blocked = await f.run();
  assert.equal(blocked.status, "blocked");
  assert.match(blocked.blocked_reason, /CYCLES_EXHAUSTED/);
  assert.equal(f.counts.planner, 2);
  assert.equal(f.goalStore.listGoals().length, 0);
});

test("budget conservatively reserves child and final review before publishing executable work", async (t) => {
  const f = fixture(t);
  f.store.createMission(input({ max_calls: 4 }));
  const blocked = await f.run();
  assert.match(blocked.blocked_reason, /BUDGET_EXHAUSTED/);
  assert.equal(blocked.calls_reserved, 2);
  assert.equal(f.goalStore.listGoals().length, 0);
  assert.equal(f.counts.worker, 0);
});

test("unauthorized plan cannot add capabilities or workers", async (t) => {
  const f = fixture(t, {
    planValue: () => {
      const p = plan();
      p.steps[0].capability = "repo.write";
      return p;
    },
  });
  f.store.createMission(input());
  const m = await f.run();
  assert.equal(m.status, "blocked");
  assert.match(m.blocked_reason, /UNAUTHORIZED_PLAN/);
  assert.equal(f.goalStore.listGoals().length, 0);
});

test("wrong phase fingerprint is rejected", async (t) => {
  const f = fixture(t, { wrongHash: true });
  f.store.createMission(input());
  const m = await f.run();
  assert.match(m.blocked_reason, /RESULT_IDENTITY_MISMATCH/);
  assert.equal(m.phase, "plan");
  assert.equal(f.goalStore.listGoals().length, 0);
});

test("concurrent directors invoke a mission phase only once", async (t) => {
  let release;
  const gate = new Promise((r) => (release = r));
  const f = fixture(t, { hook: () => gate });
  f.store.createMission(input());
  const pending = f.director.tick();
  await new Promise((r) => setTimeout(r, 5));
  await new MissionDirector({
    store: f.store,
    goalStore: f.goalStore,
    workers: f.workers,
  }).tick();
  assert.equal(f.counts.planner, 1);
  release();
  await pending;
  assert.equal(f.store.getMission("project", "M1").phase, "plan_review");
});

test("expired lease blocks recovery and ignores a late result", async (t) => {
  let release;
  const gate = new Promise((r) => (release = r));
  const f = fixture(t, { hook: () => gate });
  f.store.createMission(input());
  const pending = f.director.tick();
  await new Promise((r) => setTimeout(r, 5));
  f.advance(6000);
  await f.director.tick();
  release();
  await pending;
  const m = f.store.getMission("project", "M1");
  assert.equal(m.status, "blocked");
  assert.match(m.blocked_reason, /LEASE_EXPIRED/);
  assert.equal(m.plan, null);
  assert.equal(f.counts.planner, 1);
});

test("paused missions do not continue; resume retains phase", async (t) => {
  const f = fixture(t);
  f.store.createMission(input());
  await f.director.tick();
  f.store.pauseMission("project", "M1");
  await f.director.tick();
  assert.equal(f.counts.planReview, 0);
  f.reopen();
  assert.equal(f.store.getMission("project", "M1").status, "paused");
  f.store.resumeMission("project", "M1");
  const done = await f.run();
  assert.equal(done.status, "completed");
});

test("child tick does not run unrelated goals in the same namespace", async (t) => {
  const f = fixture(t);
  f.goalStore.createGoal({
    goal_id: "unrelated",
    namespace: "project",
    objective: "Do not run",
    acceptance: ["No execution"],
    grants: ["repo.read", "review"],
    max_calls: 2,
    max_attempts: 1,
    revisit_seconds: 0,
    steps: [
      {
        step_id: "compute",
        kind: "research",
        worker: "worker",
        reviewer: "reviewer",
        capability: "repo.read",
        input: { operation: "sum", values: [1] },
        depends_on: [],
      },
    ],
  });
  f.store.createMission(input());
  const done = await f.run();
  assert.equal(done.status, "completed");
  assert.equal(
    f.goalStore.getGoal("project", "unrelated").steps[0].status,
    "pending",
  );
  assert.equal(f.counts.worker, 1);
});

test("namespaces deny unauthorized workers while other mission continues", async (t) => {
  const f = fixture(t);
  f.store.createMission(input());
  f.store.createMission(input({ namespace: "personal" }));
  await f.director.tick();
  assert.equal(f.store.getMission("personal", "M1").status, "blocked");
  assert.match(
    f.store.getMission("personal", "M1").blocked_reason,
    /NAMESPACE_DENIED/,
  );
  const done = await f.run();
  assert.equal(done.status, "completed");
});

test("demo adapters cannot establish completion for a live mission", async (t) => {
  const f = fixture(t);
  f.workers.planner.type = "demo";
  f.store.createMission(input());
  const m = await f.run();
  assert.match(m.blocked_reason, /DEMO_MODE_REQUIRED/);
  assert.equal(f.counts.planner, 0);
});

test("missing or disabled adapters do not consume model call reservations or planning cycles", async (t) => {
  const f = fixture(t);
  delete f.workers.planner;
  f.store.createMission(input());
  const m = await f.run();
  assert.equal(m.calls_reserved, 0);
  assert.equal(m.cycle, 0);
  assert.match(m.blocked_reason, /WORKER_UNAVAILABLE/);
  assert.ok(
    f.store
      .events("project", "M1")
      .some((e) => e.type === "reservation_refunded"),
  );
});

test("pause during a child invocation prevents its review and all subsequent child claims", async (t) => {
  const f = fixture(t, {
    planValue: () => {
      const p = plan();
      p.steps.push({
        ...p.steps[0],
        step_id: "second",
        depends_on: ["compute"],
      });
      return p;
    },
  });
  f.store.createMission(input());
  await f.director.tick();
  await f.director.tick();
  let release;
  const gate = new Promise((r) => (release = r)),
    run = f.workers.worker.run;
  f.workers.worker.run = async (p) => {
    const v = await run(p);
    await gate;
    return v;
  };
  const pending = f.director.tick();
  await new Promise((r) => setTimeout(r, 5));
  f.store.pauseMission("project", "M1");
  release();
  await pending;
  await f.director.tick();
  const m = f.store.getMission("project", "M1"),
    child = f.goalStore.getGoal("project", m.child_goal_id);
  assert.equal(m.status, "paused");
  assert.equal(f.counts.worker, 1);
  assert.equal(child.steps[0].status, "review");
  assert.equal(child.steps[1].status, "pending");
});

test("pause during final acceptance remains paused until resume commits the accepted completion", async (t) => {
  const f = fixture(t);
  f.store.createMission(input());
  for (let i = 0; i < 4; i++) await f.director.tick();
  assert.equal(f.store.getMission("project", "M1").phase, "final_review");
  let release;
  const gate = new Promise((r) => (release = r)),
    run = f.workers.reviewer.run;
  f.workers.reviewer.run = async (p) => {
    const v = await run(p);
    if (p.input.operation === "evaluate-mission") await gate;
    return v;
  };
  const pending = f.director.tick();
  await new Promise((r) => setTimeout(r, 5));
  f.store.pauseMission("project", "M1");
  release();
  await pending;
  assert.equal(f.store.getMission("project", "M1").status, "paused");
  assert.equal(f.store.getMission("project", "M1").resume_status, "completed");
  f.store.resumeMission("project", "M1");
  assert.equal(f.store.getMission("project", "M1").status, "completed");
});

test("all planning and goal-review packets/results survive replanning and reopening in the private audit ledger", async (t) => {
  const f = fixture(t, {
    decide: (p, c) =>
      p.input.operation === "evaluate-mission" && c.finalReview === 1
        ? "reject"
        : "accept",
  });
  f.store.createMission(input({ max_calls: 10, max_cycles: 2 }));
  assert.equal((await f.run(15)).status, "completed");
  f.reopen();
  const calls = f.store.calls("project", "M1");
  assert.equal(calls.length, 6);
  assert.equal(new Set(calls.map((c) => c.attempt_id)).size, 6);
  assert.ok(calls.every((c) => c.packet.grant && c.result && c.error === null));
  assert.equal(calls.filter((c) => c.phase === "final_review").length, 2);
  assert.equal(f.goalStore.listGoals().length, 2);
});

test("pause during acceptance cannot auto-resume maintenance after its wake time", async (t) => {
  const f = fixture(t);
  f.store.createMission(input({ revisit_seconds: 5 }));
  for (let i = 0; i < 4; i++) await f.director.tick();
  let release;
  const gate = new Promise((r) => (release = r)),
    run = f.workers.reviewer.run;
  f.workers.reviewer.run = async (p) => {
    const v = await run(p);
    if (p.input.operation === "evaluate-mission") await gate;
    return v;
  };
  const pending = f.director.tick();
  await new Promise((r) => setTimeout(r, 5));
  f.store.pauseMission("project", "M1");
  release();
  await pending;
  f.advance(10000);
  await f.director.tick();
  const paused = f.store.getMission("project", "M1");
  assert.equal(paused.status, "paused");
  assert.equal(paused.resume_status, "maintenance");
  assert.equal(f.counts.planner, 1);
  f.store.resumeMission("project", "M1");
  assert.equal(f.store.getMission("project", "M1").status, "maintenance");
});

test("a malformed read-only model plan is automatically repaired within the original budget", async (t) => {
  let proposals = 0;
  const f = fixture(t, {
    planValue: () => (proposals++ === 0 ? { steps: [] } : plan()),
  });
  f.store.createMission(input({ max_calls: 6, max_cycles: 2 }));
  const done = await f.run();
  assert.equal(done.status, "completed");
  assert.equal(done.calls_reserved, 6);
  assert.equal(done.cycle, 2);
  assert.ok(done.observations.some((o) => o.stage === "planning_error"));
  assert.equal(f.store.calls("project", "M1").length, 4);
});

test("bad JSON model plan waits for backoff then repairs without an operator retry", async (t) => {
  const f = fixture(t);
  f.store.createMission(input({ max_calls: 6, max_cycles: 2 }));
  const original = f.workers.planner.run;
  let n = 0;
  f.workers.planner.run = async (p) => {
    const r = await original(p);
    if (n++ === 0) r.output.summary = "{broken-json";
    return r;
  };
  await f.director.tick();
  const repairing = f.store.getMission("project", "M1");
  assert.equal(repairing.status, "active");
  assert.equal(repairing.phase, "plan");
  assert.ok(repairing.next_wake_at > repairing.updated_at);
  await f.director.tick();
  assert.equal(f.counts.planner, 1);
  f.advance(1100);
  const done = await f.run();
  assert.equal(done.status, "completed");
  assert.equal(done.calls_reserved, 6);
  assert.equal(f.counts.planner, 2);
});

test("repeated bad JSON planning ends blocked when its original cycle limit is exhausted", async (t) => {
  const f = fixture(t);
  f.store.createMission(input({ max_calls: 10, max_cycles: 2 }));
  const original = f.workers.planner.run;
  f.workers.planner.run = async (p) => {
    const r = await original(p);
    r.output.summary = "{broken-json";
    return r;
  };
  const result = await f.run();
  assert.equal(result.status, "blocked");
  assert.equal(result.cycle, 2);
  assert.equal(result.calls_reserved, 2);
  assert.equal(f.counts.planner, 2);
  assert.equal(f.goalStore.listGoals().length, 0);
});

test("schema-only invalid planner output repairs, while identity mismatches remain blocked", async (t) => {
  const f = fixture(t);
  f.store.createMission(input({ max_calls: 6, max_cycles: 2 }));
  const original = f.workers.planner.run;
  let n = 0;
  f.workers.planner.run = async (p) => {
    const r = await original(p);
    if (n++ === 0) r.output = { artifacts: [] };
    return r;
  };
  const result = await f.run();
  assert.equal(result.status, "completed");
  assert.equal(result.cycle, 2);
  assert.equal(result.calls_reserved, 6);
});
