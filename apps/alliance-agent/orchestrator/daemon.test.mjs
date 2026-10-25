import test from "node:test";
import assert from "node:assert/strict";
import { runCoordinator, tickLog } from "./daemon.mjs";

const delay = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

test("daemon advances repeatedly without overlapping coordinator ticks", async () => {
  let active = 0;
  let maximum = 0;
  const observed = [];
  const coordinator = {
    async tick({ namespace, signal }) {
      assert.equal(namespace, "project");
      assert.equal(signal.aborted, false);
      active++;
      maximum = Math.max(maximum, active);
      await delay(8);
      active--;
      return { completed_steps: observed.length + 1 };
    },
  };
  const result = await runCoordinator({
    coordinator,
    namespace: "project",
    intervalMs: 1,
    maxTicks: 3,
    onTick: (summary) => observed.push(summary.completed_steps),
  });
  assert.equal(maximum, 1);
  assert.deepEqual(observed, [1, 2, 3]);
  assert.equal(result.ticks, 3);
  assert.equal(result.stopped, "max-ticks");
});

test("pre-aborted daemon never claims work", async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const result = await runCoordinator({
    coordinator: {
      tick() {
        calls++;
      },
    },
    signal: controller.signal,
  });
  assert.equal(calls, 0);
  assert.equal(result.stopped, "signal");
});

test("SIGTERM-style abort propagates to current worker and prevents further ticks", async () => {
  const controller = new AbortController();
  let calls = 0;
  let workerAborted = false;
  const coordinator = {
    tick({ signal }) {
      calls++;
      return new Promise((_, reject) =>
        signal.addEventListener(
          "abort",
          () => {
            workerAborted = true;
            const error = new Error("cancelled");
            error.name = "AbortError";
            reject(error);
          },
          { once: true },
        ),
      );
    },
  };
  const promise = runCoordinator({
    coordinator,
    signal: controller.signal,
    intervalMs: 1,
    shutdownTimeoutMs: 100,
  });
  await delay(5);
  controller.abort();
  const result = await promise;
  assert.equal(workerAborted, true);
  assert.equal(calls, 1);
  assert.equal(result.stopped, "signal");
});

test("uncooperative in-flight work fails within shutdown bound", async () => {
  const controller = new AbortController();
  const promise = runCoordinator({
    coordinator: { tick: () => new Promise(() => {}) },
    signal: controller.signal,
    shutdownTimeoutMs: 10,
  });
  await delay(5);
  controller.abort();
  await assert.rejects(promise, { code: "SHUTDOWN_TIMEOUT" });
});

test("abort during idle wait returns promptly and starts no further work", async () => {
  const controller = new AbortController();
  let calls = 0;
  const promise = runCoordinator({
    coordinator: {
      async tick() {
        calls++;
        return {};
      },
    },
    signal: controller.signal,
    intervalMs: 10000,
    onTick: () => controller.abort(),
  });
  const result = await promise;
  assert.equal(calls, 1);
  assert.equal(result.stopped, "signal");
});

test("daemon log projection excludes private worker output and error bodies", () => {
  const log = tickLog(
    {
      task_calls: 1,
      errors: [{ message: "PRIVATE" }],
      output: "PRIVATE",
      objective: "PRIVATE",
      steps: [{ input: "PRIVATE" }],
    },
    2,
  );
  assert.equal(log.tick, 2);
  assert.equal(log.task_calls, 1);
  assert.equal(log.errors, 1);
  assert.equal(JSON.stringify(log).includes("PRIVATE"), false);
});
