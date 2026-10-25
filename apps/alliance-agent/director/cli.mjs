#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { MissionStore, MissionDirector } from "./core.mjs";
import { GoalStore } from "../orchestrator/store.mjs";
import {
  createWorkerRegistry,
  doctorRegistry,
} from "../orchestrator/adapters/index.mjs";
import { loadConfig, resolveDataPaths } from "../orchestrator/config.mjs";
import { runCoordinator } from "../orchestrator/daemon.mjs";

const HELP = `CIAOMIND persistent mission director (Node.js 24+)\n\nUsage: node director/cli.mjs [--db private/missions.sqlite] [--goals-db private/mission-goals.sqlite] [--config private.json] COMMAND\n\n  create --file mission.json       Natural objective + acceptance; no hand-authored steps\n  list [--namespace project]       Mission summaries, no private objective text\n  show|events|calls NAMESPACE MISSION_ID\n  pause|resume|cancel|retry NAMESPACE MISSION_ID\n  tick [--namespace project]       Advance one persisted phase per active mission\n  run [--interval-ms 5000] [--max-ticks N] [--once]\n  doctor                          Adapter readiness only; never calls models\n\nDefault state is private CIAOMIND_DATA_DIR or ~/.local/share/ciaomind.\nLive mode requires explicitly enabled, authenticated adapters. Demo mode is synthetic,\nnot AI planning. Calls include planner/reviews/child reservations, not dollar limits.\n`;
function summary(m) {
  return {
    namespace: m.namespace,
    mission_id: m.mission_id,
    mode: m.mode,
    status: m.status,
    phase: m.phase,
    cycle: m.cycle,
    calls_reserved: m.calls_reserved,
    max_calls: m.max_calls,
    blocked_reason: m.blocked_reason,
    next_wake_at: m.next_wake_at,
  };
}
export async function main(
  argv = process.argv.slice(2),
  { stdout = process.stdout, stderr = process.stderr, signal } = {},
) {
  let store,
    goalStore,
    removeSignals = () => {};
  const write = (stream, v) => stream.write(JSON.stringify(v, null, 2) + "\n");
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        db: { type: "string" },
        "goals-db": { type: "string" },
        config: { type: "string" },
        file: { type: "string" },
        namespace: { type: "string" },
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
    const [command, namespace, id] = positionals,
      individual = [
        "show",
        "events",
        "calls",
        "pause",
        "resume",
        "cancel",
        "retry",
      ];
    if (
      ![...individual, "create", "list", "doctor", "tick", "run"].includes(
        command,
      )
    )
      throw new Error("Unknown mission command");
    if (positionals.length !== (individual.includes(command) ? 3 : 1))
      throw new Error(
        "Expected command and exactly NAMESPACE MISSION_ID where applicable",
      );
    if (
      values.namespace !== undefined &&
      !["personal", "project"].includes(values.namespace)
    )
      throw new Error("Invalid --namespace");
    const config = loadConfig(values.config);
    if (command === "doctor") {
      write(stdout, {
        workers: await doctorRegistry(config),
        note: "Readiness does not prove a successful authenticated mission",
      });
      return 0;
    }
    const paths = resolveDataPaths({ db: values.db }),
      dbPath = values.db
        ? paths.dbPath
        : join(paths.directory, "missions.sqlite");
    const goalPath = values["goals-db"]
      ? resolve(values["goals-db"])
      : join(dirname(dbPath), "mission-goals.sqlite");
    if (resolve(dbPath) === resolve(goalPath))
      throw new Error(
        "Mission and goal state must use separate database paths",
      );
    store = new MissionStore({ dbPath });
    if (command === "create") {
      if (!values.file) throw new Error("--file is required");
      const source = readFileSync(
        values.file === "-" ? 0 : values.file,
        "utf8",
      );
      if (Buffer.byteLength(source) > 1_000_000)
        throw new Error("Mission JSON exceeds 1 MB");
      write(stdout, store.createMission(JSON.parse(source)));
    } else if (command === "list")
      write(stdout, store.listMissions(values.namespace).map(summary));
    else if (command === "show") {
      const mission = store.getMission(namespace, id);
      if (mission.child_goal_id) {
        goalStore = new GoalStore({ dbPath: goalPath });
        try {
          mission.child_details = goalStore.getGoal(
            namespace,
            mission.child_goal_id,
          );
        } catch (error) {
          mission.child_lookup_error = error.code ?? "NOT_FOUND";
        }
      }
      write(stdout, mission);
    } else if (command === "events") write(stdout, store.events(namespace, id));
    else if (command === "calls") write(stdout, store.calls(namespace, id));
    else if (command === "pause")
      write(stdout, store.pauseMission(namespace, id));
    else if (command === "resume")
      write(stdout, store.resumeMission(namespace, id));
    else if (command === "cancel")
      write(stdout, store.cancelMission(namespace, id));
    else if (command === "retry")
      write(stdout, store.retryMission(namespace, id));
    else {
      goalStore = new GoalStore({ dbPath: goalPath });
      const director = new MissionDirector({
        store,
        goalStore,
        workers: createWorkerRegistry(config),
      });
      if (command === "tick")
        write(
          stdout,
          await director.tick({ namespace: values.namespace, signal }),
        );
      else {
        const controller = new AbortController(),
          stop = () => controller.abort(new Error("Termination requested"));
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
        const result = await runCoordinator({
          coordinator: director,
          namespace: values.namespace,
          intervalMs: values["interval-ms"]
            ? Number(values["interval-ms"])
            : config.poll_interval_ms,
          maxTicks: values.once
            ? 1
            : values["max-ticks"]
              ? Number(values["max-ticks"])
              : Infinity,
          signal: controller.signal,
          shutdownTimeoutMs: config.shutdown_timeout_ms,
          onTick: (r, { tick }) =>
            write(stdout, {
              event: "mission_tick",
              tick,
              missions_scanned: r.missions_scanned,
              planner_calls: r.planner_calls,
              plan_reviews: r.plan_reviews,
              mission_reviews: r.mission_reviews,
              completed_missions: r.completed_missions,
              blocked_missions: r.blocked_missions,
              errors: r.errors.length,
            }),
        });
        write(stdout, {
          event: "stopped",
          ticks: result.ticks,
          reason: result.stopped,
        });
      }
    }
    return 0;
  } catch (e) {
    write(stderr, {
      error: e.code ?? "CLI_ERROR",
      message:
        e instanceof SyntaxError
          ? "Malformed JSON input"
          : String(e.message ?? e),
    });
    return 1;
  } finally {
    removeSignals();
    goalStore?.close();
    store?.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = await main();
