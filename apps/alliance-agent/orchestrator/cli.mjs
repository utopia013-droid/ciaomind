#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { GoalStore } from "./store.mjs";
import { Coordinator } from "./engine.mjs";
import { createWorkerRegistry, doctorRegistry } from "./adapters/index.mjs";
import { loadConfig, resolveDataPaths } from "./config.mjs";
import { runCoordinator, tickLog } from "./daemon.mjs";

const HELP = `CIAOMIND goal orchestrator (Node.js 24+)

Usage: node orchestrator/cli.mjs [--db PATH] [--config private.json] COMMAND

  create --file goal.json             Register an immutable goal contract; --file - reads stdin
  list [--namespace project]          List goal summaries (personal/project are separate scopes)
  show NAMESPACE GOAL_ID              Read a goal, steps and result evidence
  events NAMESPACE GOAL_ID            Read durable audit events
  pause|resume|cancel NAMESPACE GOAL_ID
  retry NAMESPACE GOAL_ID [--step STEP_ID]
  tick [--namespace project]          Run one coordinator tick
  run [--namespace project] [--interval-ms 5000] [--max-ticks N] [--once]
                                      Serial polling; SIGINT/SIGTERM stops new work
  doctor                             Safe adapter readiness; does not invoke models

Default state: CIAOMIND_DATA_DIR/goals.sqlite, or ~/.local/share/ciaomind/goals.sqlite.
Keep this database, configuration and real inputs outside public repositories.
Default workers are explicitly local demos. Real adapters require explicit configuration
and CIAOMIND_ENABLE_WORKERS=1; this flag does not prove account authorization or budget.
`;

const writeJSON = (stream, value) =>
  stream.write(`${JSON.stringify(value, null, 2)}\n`);

function goalSummary(goal) {
  const result = {};
  for (const key of [
    "namespace",
    "goal_id",
    "version",
    "goal_version",
    "status",
    "next_wake_at",
    "next_wake",
    "calls_reserved",
    "max_calls",
    "blocked_reason",
  ]) {
    if (goal[key] !== undefined) result[key] = goal[key];
  }
  return result;
}

export async function main(
  argv = process.argv.slice(2),
  { stdout = process.stdout, stderr = process.stderr, signal } = {},
) {
  let store;
  let removeSignals = () => {};
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        db: { type: "string" },
        config: { type: "string" },
        file: { type: "string" },
        namespace: { type: "string" },
        step: { type: "string" },
        "interval-ms": { type: "string" },
        "max-ticks": { type: "string" },
        once: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    });
    if (values.help || !positionals.length) {
      stdout.write(HELP);
      return 0;
    }
    const [command, namespace, goalId] = positionals;
    const goalCommands = [
      "show",
      "events",
      "pause",
      "resume",
      "retry",
      "cancel",
    ];
    const commands = [
      ...goalCommands,
      "create",
      "list",
      "tick",
      "run",
      "doctor",
    ];
    if (!commands.includes(command))
      throw new Error(`Unknown command ${command}`);
    if (positionals.length !== (goalCommands.includes(command) ? 3 : 1))
      throw new Error(
        "Expected command with exactly NAMESPACE and GOAL_ID when applicable",
      );
    if (
      values.namespace !== undefined &&
      !["personal", "project"].includes(values.namespace)
    )
      throw new Error("--namespace must be personal or project");
    if (
      goalCommands.includes(command) &&
      !["personal", "project"].includes(namespace)
    )
      throw new Error("NAMESPACE must be personal or project");
    const config = loadConfig(values.config);
    if (command === "doctor") {
      const adapters = await doctorRegistry(config);
      writeJSON(stdout, {
        node: process.versions.node,
        workers_enabled: process.env.CIAOMIND_ENABLE_WORKERS === "1",
        adapters,
        note: "Readiness only; no authenticated end-to-end task is claimed.",
      });
      return 0;
    }
    const { dbPath } = resolveDataPaths({ db: values.db });
    store = new GoalStore({ dbPath });
    if (command === "create") {
      if (!values.file) throw new Error("--file is required");
      const source = readFileSync(
        values.file === "-" ? 0 : values.file,
        "utf8",
      );
      if (Buffer.byteLength(source) > 1_000_000)
        throw new Error("Goal JSON exceeds 1 MB");
      let contract;
      try {
        contract = JSON.parse(source);
      } catch {
        throw new Error("Goal input is not valid JSON");
      }
      writeJSON(stdout, store.createGoal(contract));
    } else if (command === "list") {
      writeJSON(stdout, store.listGoals(values.namespace).map(goalSummary));
    } else if (command === "show")
      writeJSON(stdout, store.getGoal(namespace, goalId));
    else if (command === "events")
      writeJSON(stdout, store.events(namespace, goalId));
    else if (command === "pause")
      writeJSON(stdout, store.pauseGoal(namespace, goalId));
    else if (command === "resume")
      writeJSON(stdout, store.resumeGoal(namespace, goalId));
    else if (command === "cancel")
      writeJSON(stdout, store.cancelGoal(namespace, goalId));
    else if (command === "retry")
      writeJSON(
        stdout,
        store.retryBlocked(namespace, goalId, { step_id: values.step }),
      );
    else {
      const coordinator = new Coordinator({
        store,
        workers: createWorkerRegistry(config),
      });
      if (command === "tick") {
        const summary = await coordinator.tick({
          namespace: values.namespace,
          signal,
        });
        writeJSON(stdout, summary);
      } else {
        const own = new AbortController();
        const stop = () => own.abort(new Error("Termination requested"));
        if (signal) {
          signal.addEventListener("abort", stop, { once: true });
          if (signal.aborted) stop();
          removeSignals = () => signal.removeEventListener("abort", stop);
        } else {
          process.once("SIGTERM", stop);
          process.once("SIGINT", stop);
          removeSignals = () => {
            process.removeListener("SIGTERM", stop);
            process.removeListener("SIGINT", stop);
          };
        }
        const intervalMs =
          values["interval-ms"] === undefined
            ? config.poll_interval_ms
            : Number(values["interval-ms"]);
        const maxTicks = values.once
          ? 1
          : values["max-ticks"] === undefined
            ? Infinity
            : Number(values["max-ticks"]);
        const summary = await runCoordinator({
          coordinator,
          namespace: values.namespace,
          intervalMs,
          maxTicks,
          signal: own.signal,
          shutdownTimeoutMs: config.shutdown_timeout_ms,
          onTick: (result, { tick }) =>
            stdout.write(`${JSON.stringify(tickLog(result, tick))}\n`),
        });
        // Avoid printing last_summary: it may contain worker content.
        writeJSON(stdout, {
          event: "stopped",
          ticks: summary.ticks,
          reason: summary.stopped,
        });
      }
    }
    return 0;
  } catch (error) {
    writeJSON(stderr, {
      error: error.code || "CLI_ERROR",
      message: error.message,
    });
    return 1;
  } finally {
    removeSignals();
    store?.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = await main();
