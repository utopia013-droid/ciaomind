import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { MissionStore } from "../../director/core.mjs";
import { GoalStore } from "../../orchestrator/store.mjs";

export function withMissions<T>(run: (store: MissionStore) => T): T {
  if (process.env.VERCEL)
    throw new Error(
      "Persistent local mission storage is required; hosted authorization is not configured.",
    );
  const directory = resolve(
    process.env.CIAOMIND_DATA_DIR ??
      join(homedir(), ".local", "share", "ciaomind"),
  );
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const store = new MissionStore({
    dbPath: join(directory, "missions.sqlite"),
  });
  try {
    return run(store);
  } finally {
    store.close();
  }
}

export function readMissionChild(namespace: "personal" | "project", goalId: string) {
  if (process.env.VERCEL)
    throw new Error("Persistent local mission storage is required.");
  const directory = resolve(
    process.env.CIAOMIND_DATA_DIR ??
      join(homedir(), ".local", "share", "ciaomind"),
  );
  const path = join(directory, "mission-goals.sqlite");
  if (!existsSync(path)) return null;
  const store = new GoalStore({ dbPath: path });
  try {
    return store.getGoal(namespace, goalId);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "NOT_FOUND")
      return null;
    throw error;
  } finally {
    store.close();
  }
}
