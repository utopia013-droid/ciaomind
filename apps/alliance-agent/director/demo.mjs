import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MissionStore, MissionDirector } from "./core.mjs";
import { GoalStore } from "../orchestrator/store.mjs";
import { createWorkerRegistry } from "../orchestrator/adapters/index.mjs";
import { DEFAULT_CONFIG } from "../orchestrator/config.mjs";
const directory = mkdtempSync(join(tmpdir(), "ciaomind-mission-demo-"));
let store, goalStore;
try {
  store = new MissionStore({ dbPath: join(directory, "missions.sqlite") });
  goalStore = new GoalStore({ dbPath: join(directory, "goals.sqlite") });
  const input = JSON.parse(
    readFileSync(
      new URL("./examples/demo-mission.json", import.meta.url),
      "utf8",
    ),
  );
  store.createMission(input);
  const workers = createWorkerRegistry(structuredClone(DEFAULT_CONFIG));
  let director = new MissionDirector({ store, goalStore, workers });
  for (let i = 0; i < 12; i++) {
    const result = await director.tick();
    let m = store.getMission(input.namespace, input.mission_id);
    console.log(
      JSON.stringify({
        demo: "synthetic-local-no-model",
        tick: i + 1,
        status: m.status,
        phase: m.phase,
        calls_reserved: m.calls_reserved,
        completed_missions: result.completed_missions,
      }),
    );
    if (i === 1) {
      store.close();
      goalStore.close();
      store = new MissionStore({ dbPath: join(directory, "missions.sqlite") });
      goalStore = new GoalStore({ dbPath: join(directory, "goals.sqlite") });
      director = new MissionDirector({ store, goalStore, workers });
    }
    if (m.status === "completed") {
      console.log(
        JSON.stringify({
          demonstration: "synthetic-local-no-model",
          reopened_after_planning: true,
          mission_completed: true,
          remote_vendor_authenticated: false,
        }),
      );
      break;
    }
    if (m.status === "blocked") throw new Error(m.blocked_reason);
  }
  if (
    store.getMission(input.namespace, input.mission_id).status !== "completed"
  )
    throw new Error("Demo did not finish");
} finally {
  store?.close();
  goalStore?.close();
  rmSync(directory, { recursive: true, force: true });
}
