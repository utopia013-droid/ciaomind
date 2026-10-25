import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { GoalStore } from "../../orchestrator/store.mjs";

// Local single-owner bridge; the daemon owns worker execution separately.
export function withGoals<T>(run: (store: GoalStore) => T): T {
  if (process.env.VERCEL) {
    throw new Error(
      "The goal store requires a private persistent local disk; hosted authorization is not configured.",
    );
  }
  const directory = resolve(
    process.env.CIAOMIND_DATA_DIR ??
      join(homedir(), ".local", "share", "ciaomind"),
  );
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const store = new GoalStore({ dbPath: join(directory, "goals.sqlite") });
  try {
    return run(store);
  } finally {
    store.close();
  }
}
