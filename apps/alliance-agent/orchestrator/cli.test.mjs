import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("./cli.mjs", import.meta.url));
const demo = JSON.parse(
  readFileSync(new URL("./examples/demo-goal.json", import.meta.url), "utf8"),
);
const env = {
  ...process.env,
  CIAOMIND_CONFIG: "",
  CIAOMIND_ENABLE_WORKERS: "",
};

function fixture(run) {
  const directory = mkdtempSync(join(tmpdir(), "ciaomind-goal-cli-"));
  const db = join(directory, "goals.sqlite");
  const command = (args, input, expect = 0) => {
    const result = spawnSync(process.execPath, [cli, "--db", db, ...args], {
      env,
      input,
      encoding: "utf8",
      timeout: 10000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, expect, result.stderr);
    return result;
  };
  return Promise.resolve()
    .then(() => run({ directory, db, command }))
    .finally(() => rmSync(directory, { recursive: true, force: true }));
}

test("CLI subprocesses persist goals and complete dependency/review loop without further prompts", () =>
  fixture(({ command }) => {
    const created = JSON.parse(
      command(["create", "--file", "-"], JSON.stringify(demo)).stdout,
    );
    assert.equal(created.status, "active");
    assert.equal(
      JSON.parse(command(["show", "project", demo.goal_id]).stdout).steps
        .length,
      2,
    );
    const run = command(["run", "--interval-ms", "25", "--max-ticks", "3"]);
    assert.ok(run.stdout.includes('"event":"tick"'));
    assert.ok(run.stdout.includes('"event": "stopped"'));
    assert.equal(run.stdout.includes(demo.objective), false);
    const completed = JSON.parse(
      command(["show", "project", demo.goal_id]).stdout,
    );
    assert.equal(completed.status, "completed");
    assert.ok(completed.steps.every((step) => step.status === "done"));
    assert.equal(completed.calls_reserved, 4);
    const events = JSON.parse(
      command(["events", "project", demo.goal_id]).stdout,
    );
    command(["run", "--once"]);
    assert.deepEqual(
      JSON.parse(command(["events", "project", demo.goal_id]).stdout),
      events,
    );
    assert.equal(
      JSON.parse(command(["show", "project", demo.goal_id]).stdout)
        .calls_reserved,
      4,
    );
  }));

test("missing worker becomes visible blocked state and does not stop unrelated goals", () =>
  fixture(({ command }) => {
    const missing = {
      ...demo,
      goal_id: "missing-worker",
      steps: [{ ...demo.steps[0], worker: "not-configured" }],
    };
    command(["create", "--file", "-"], JSON.stringify(missing));
    command(["create", "--file", "-"], JSON.stringify(demo));
    command(["tick"]);
    const bad = JSON.parse(
      command(["show", "project", missing.goal_id]).stdout,
    );
    assert.equal(bad.status, "blocked");
    assert.ok(bad.steps[0].blocked_reason.includes("WORKER_UNAVAILABLE"));
    assert.equal(bad.calls_reserved, 0);
    assert.equal(
      JSON.parse(command(["show", "project", demo.goal_id]).stdout).status,
      "completed",
    );
  }));

test("private/project scopes and call reservations survive stopping and restarting CLI", () =>
  fixture(({ command }) => {
    const limited = { ...demo, goal_id: "limited-goal", max_calls: 1 };
    command(["create", "--file", "-"], JSON.stringify(limited));
    command(["run", "--once"]);
    const stopped = JSON.parse(
      command(["show", "project", limited.goal_id]).stdout,
    );
    assert.equal(stopped.status, "blocked");
    assert.equal(stopped.calls_reserved, 1);
    assert.ok(stopped.steps.some((step) => step.result));
    command(["run", "--once"]);
    const restarted = JSON.parse(
      command(["show", "project", limited.goal_id]).stdout,
    );
    assert.equal(restarted.calls_reserved, 1);
    assert.deepEqual(
      restarted.steps.map((step) => step.attempt_id),
      stopped.steps.map((step) => step.attempt_id),
    );
    command(
      ["create", "--file", "-"],
      JSON.stringify({ ...demo, namespace: "personal" }),
    );
    const projectList = JSON.parse(
      command(["list", "--namespace", "project"]).stdout,
    );
    assert.ok(projectList.every((goal) => goal.namespace === "project"));
    assert.equal(command(["list"]).stdout.includes(demo.objective), false);
    command(["tick", "--namespace", "personal"]);
    const personal = JSON.parse(
      command(["show", "personal", demo.goal_id]).stdout,
    );
    assert.equal(personal.status, "blocked");
    assert.ok(personal.steps[0].blocked_reason.includes("NAMESPACE_DENIED"));
  }));

test("doctor does not open a state database and malformed JSON does not echo private text", () =>
  fixture(({ db, command }) => {
    const doctor = JSON.parse(command(["doctor"]).stdout);
    assert.equal(doctor.workers_enabled, false);
    assert.ok(doctor.adapters.every((worker) => worker.type === "demo"));
    assert.equal(existsSync(db), false);
    const bad = command(
      ["create", "--file", "-"],
      '{"objective":"PRIVATE_SENTENCE"',
      1,
    );
    assert.equal(bad.stderr.includes("PRIVATE_SENTENCE"), false);
    assert.equal(JSON.parse(command(["list"]).stdout).length, 0);
  }));

test("daemon responds to actual SIGTERM without claiming another tick", () =>
  fixture(async ({ db, command }) => {
    command(["create", "--file", "-"], JSON.stringify(demo));
    const child = spawn(
      process.execPath,
      [cli, "--db", db, "run", "--interval-ms", "10000"],
      { env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "",
      errors = "",
      stopped = false;
    child.stderr.on("data", (data) => {
      errors += data;
    });
    const timeout = setTimeout(() => child.kill("SIGKILL"), 10000);
    try {
      const status = await new Promise((resolve, reject) => {
        child.on("error", reject);
        child.stdout.on("data", (data) => {
          output += data;
          if (!stopped && output.includes('"event":"tick"')) {
            stopped = true;
            child.kill("SIGTERM");
          }
        });
        child.on("exit", (code, signal) => resolve({ code, signal }));
      });
      assert.equal(status.code, 0, errors);
      assert.equal(status.signal, null);
      assert.equal(
        output.split("\n").filter((line) => line.includes('"event":"tick"'))
          .length,
        1,
      );
      assert.ok(output.includes('"reason": "signal"'));
      assert.equal(
        JSON.parse(command(["show", "project", demo.goal_id]).stdout).status,
        "completed",
      );
    } finally {
      clearTimeout(timeout);
      child.kill("SIGKILL");
    }
  }));
