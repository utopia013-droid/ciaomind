import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const cli = fileURLToPath(new URL("./cli.mjs", import.meta.url));
const example = fileURLToPath(
  new URL("./examples/demo-mission.json", import.meta.url),
);
const run = (db, args) =>
  spawnSync(process.execPath, [cli, "--db", db, ...args], {
    encoding: "utf8",
    timeout: 10000,
  });

test("CLI persists a natural mission and a fresh process autonomously completes the demo", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "director-cli-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = join(dir, "missions.sqlite");
  const created = run(db, ["create", "--file", example]);
  assert.equal(created.status, 0, created.stderr);
  assert.equal(JSON.parse(created.stdout).phase, "plan");
  const executed = run(db, ["run", "--interval-ms", "25", "--max-ticks", "7"]);
  assert.equal(executed.status, 0, executed.stderr);
  assert.doesNotMatch(executed.stdout, /synthetic numbers total/);
  const shown = run(db, ["show", "project", "DEMO-MISSION-001"]);
  assert.equal(shown.status, 0, shown.stderr);
  const goal = JSON.parse(shown.stdout);
  assert.equal(goal.status, "completed");
  assert.equal(goal.child_details.status, "completed");
  const calls = run(db, ["calls", "project", "DEMO-MISSION-001"]);
  assert.equal(calls.status, 0);
  assert.equal(JSON.parse(calls.stdout).length, 3);
});

test("malformed private mission JSON fails without echoing input content", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "director-cli-bad-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const r = spawnSync(
    process.execPath,
    [cli, "--db", join(dir, "m.sqlite"), "create", "--file", "-"],
    { input: '{"PRIVATE_AUDIO_SECRET":', encoding: "utf8" },
  );
  assert.equal(r.status, 1);
  assert.doesNotMatch(r.stderr, /PRIVATE_AUDIO_SECRET/);
  assert.match(r.stderr, /Malformed JSON/);
});
