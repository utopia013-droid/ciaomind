import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { ControlPlane } from "../../control/core.mjs";

// A single-user, local-only bridge. Hosted storage/auth are a separate phase.
export function withControl<T>(run: (control: ControlPlane) => T): T {
  if (process.env.VERCEL) {
    throw new Error("The SQLite adapter is local-only; hosted persistence and authorization have not been configured.");
  }
  const directory = resolve(
    process.env.CIAOMIND_DATA_DIR ?? join(homedir(), ".local", "share", "ciaomind"),
  );
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const control = new ControlPlane({ dbPath: join(directory, "tasks.sqlite") });
  try {
    return run(control);
  } finally {
    control.close();
  }
}
