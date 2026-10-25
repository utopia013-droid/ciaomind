import { readFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const DEFAULT_CONFIG = Object.freeze({
  poll_interval_ms: 5000,
  shutdown_timeout_ms: 15000,
  workers: [
    {
      id: "demo-worker",
      type: "demo",
      role: "worker",
      namespaces: ["project"],
      enabled: true,
    },
    {
      id: "demo-reviewer",
      type: "demo",
      role: "reviewer",
      namespaces: ["project"],
      enabled: true,
    },
  ],
});

function error(message) {
  const value = new Error(message);
  value.code = "INVALID_CONFIG";
  return value;
}

function positive(value, key, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw error(`${key} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

export function resolveDataPaths({ db, env = process.env } = {}) {
  const directory = resolve(
    env.CIAOMIND_DATA_DIR ?? join(homedir(), ".local", "share", "ciaomind"),
  );
  const dbPath = db ? resolve(db) : join(directory, "goals.sqlite");
  mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
  return { directory, dbPath };
}

export function loadConfig(path, { env = process.env } = {}) {
  const selected = path ?? env.CIAOMIND_CONFIG;
  let input;
  if (selected) {
    const source = readFileSync(resolve(selected), "utf8");
    if (Buffer.byteLength(source) > 256_000)
      throw error("Configuration file exceeds 256 KB");
    try {
      input = JSON.parse(source);
    } catch {
      throw error("Configuration is not valid JSON");
    }
  } else {
    input = structuredClone(DEFAULT_CONFIG);
  }
  if (!input || Array.isArray(input) || typeof input !== "object")
    throw error("Configuration must be an object");
  for (const key of Object.keys(input)) {
    if (!["workers", "poll_interval_ms", "shutdown_timeout_ms"].includes(key))
      throw error(`Unsupported configuration field: ${key}`);
  }
  if (!Array.isArray(input.workers) || input.workers.length > 30)
    throw error("workers must be an array of at most 30 workers");
  const ids = new Set();
  const workers = input.workers.map((worker) => {
    if (!worker || Array.isArray(worker) || typeof worker !== "object")
      throw error("Worker must be an object");
    const allowed = new Set([
      "id",
      "type",
      "role",
      "namespaces",
      "enabled",
      "workdir",
      "binary",
      "timeoutMs",
      "maxOutputBytes",
      "model",
      "reviewedConfig",
      "allowApiKey",
    ]);
    for (const key of Object.keys(worker))
      if (!allowed.has(key)) throw error(`Unsupported worker field: ${key}`);
    if (
      typeof worker.id !== "string" ||
      !/^[a-z][a-z0-9._-]{0,63}$/.test(worker.id) ||
      ids.has(worker.id)
    )
      throw error("Worker IDs must be unique lowercase audit labels");
    ids.add(worker.id);
    if (!["demo", "codex", "gemini"].includes(worker.type))
      throw error(`Unknown worker type for ${worker.id}`);
    if (worker.type === "demo" && !worker.id.startsWith("demo-"))
      throw error("Demo worker IDs must start with demo-");
    if (
      worker.role !== undefined &&
      !["worker", "reviewer"].includes(worker.role)
    )
      throw error(`Invalid worker role for ${worker.id}`);
    if (
      !Array.isArray(worker.namespaces) ||
      !worker.namespaces.length ||
      worker.namespaces.some((ns) => !["personal", "project"].includes(ns))
    )
      throw error(`Explicit namespaces required for ${worker.id}`);
    if (worker.enabled !== undefined && typeof worker.enabled !== "boolean")
      throw error(`enabled must be boolean for ${worker.id}`);
    for (const key of ["reviewedConfig", "allowApiKey"])
      if (worker[key] !== undefined && typeof worker[key] !== "boolean")
        throw error(`${key} must be boolean for ${worker.id}`);
    const copy = {
      ...worker,
      namespaces: [...new Set(worker.namespaces)],
      enabled: worker.enabled ?? worker.type === "demo",
    };
    if (copy.workdir !== undefined) {
      if (typeof copy.workdir !== "string" || !copy.workdir.trim())
        throw error(`Invalid workdir for ${worker.id}`);
      copy.workdir = resolve(
        selected ? dirname(resolve(selected)) : process.cwd(),
        copy.workdir,
      );
    }
    if (
      copy.binary !== undefined &&
      (typeof copy.binary !== "string" ||
        !copy.binary.trim() ||
        copy.binary.includes("\0"))
    )
      throw error(`Invalid binary for ${worker.id}`);
    if (
      copy.model !== undefined &&
      (typeof copy.model !== "string" ||
        !copy.model.trim() ||
        copy.model.length > 120)
    )
      throw error(`Invalid model for ${worker.id}`);
    if (copy.timeoutMs !== undefined)
      positive(copy.timeoutMs, "timeoutMs", 100, 600_000);
    if (copy.maxOutputBytes !== undefined)
      positive(copy.maxOutputBytes, "maxOutputBytes", 1000, 2_000_000);
    return copy;
  });
  return {
    workers,
    poll_interval_ms: positive(
      input.poll_interval_ms ?? 5000,
      "poll_interval_ms",
      25,
      3_600_000,
    ),
    shutdown_timeout_ms: positive(
      input.shutdown_timeout_ms ?? 15000,
      "shutdown_timeout_ms",
      100,
      600_000,
    ),
  };
}
