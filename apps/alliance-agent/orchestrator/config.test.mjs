import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, resolveDataPaths } from "./config.mjs";

function fixture(run) {
  const directory = mkdtempSync(join(tmpdir(), "ciaomind-config-"));
  try {
    return run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("default config contains only explicitly named project demo workers", () => {
  const config = loadConfig(undefined, { env: {} });
  assert.deepEqual(
    config.workers.map((worker) => worker.id),
    ["demo-worker", "demo-reviewer"],
  );
  assert.ok(
    config.workers.every(
      (worker) =>
        worker.type === "demo" && worker.namespaces.join() === "project",
    ),
  );
  config.workers[0].namespaces.push("personal");
  assert.deepEqual(loadConfig(undefined, { env: {} }).workers[0].namespaces, [
    "project",
  ]);
});

test("config rejects unknown command/credential fields and duplicate or ambiguous workers", () =>
  fixture((directory) => {
    const file = join(directory, "config.json");
    for (const config of [
      { workers: [], apiKey: "secret" },
      {
        workers: [
          {
            id: "worker",
            type: "codex",
            namespaces: ["project"],
            command: "shell stuff",
          },
        ],
      },
      { workers: [{ id: "worker", type: "codex", namespaces: [] }] },
      { workers: [{ id: "codex", type: "demo", namespaces: ["project"] }] },
      {
        workers: [
          {
            id: "worker",
            type: "codex",
            namespaces: ["project"],
            token: "secret",
          },
        ],
      },
      {
        workers: [
          { id: "worker", type: "codex", namespaces: ["project"] },
          { id: "worker", type: "gemini", namespaces: ["project"] },
        ],
      },
    ]) {
      writeFileSync(file, JSON.stringify(config));
      assert.throws(() => loadConfig(file), { code: "INVALID_CONFIG" });
    }
  }));

test("real workers default disabled and workdir resolves relative to private config", () =>
  fixture((directory) => {
    const file = join(directory, "config.json");
    writeFileSync(
      file,
      JSON.stringify({
        workers: [
          {
            id: "codex-worker",
            type: "codex",
            namespaces: ["project"],
            workdir: "repo",
          },
        ],
      }),
    );
    const config = loadConfig(file);
    assert.equal(config.workers[0].enabled, false);
    assert.equal(config.workers[0].workdir, join(directory, "repo"));
  }));

test("malformed configuration errors never include file contents", () =>
  fixture((directory) => {
    const file = join(directory, "config.json");
    writeFileSync(file, '{"apiKey":"DO_NOT_LOG_THIS_SECRET"');
    assert.throws(
      () => loadConfig(file),
      (error) =>
        error.code === "INVALID_CONFIG" &&
        !error.message.includes("DO_NOT_LOG_THIS_SECRET"),
    );
  }));

test("state path defaults to explicit private data directory with restrictive newly-created mode", () =>
  fixture((directory) => {
    const data = join(directory, "private-data");
    const result = resolveDataPaths({ env: { CIAOMIND_DATA_DIR: data } });
    assert.equal(result.dbPath, join(data, "goals.sqlite"));
    if (process.platform !== "win32")
      assert.equal(statSync(data).mode & 0o777, 0o700);
  }));
