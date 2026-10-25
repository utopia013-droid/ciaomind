import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  mkdirSync,
  linkSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDemoWorker,
  createCodexWorker,
  createGeminiWorker,
  createWorkerRegistry,
  doctorRegistry,
  validateResult,
} from "./index.mjs";
import { runProcess } from "./process.mjs";

function packet(worker = "demo-worker", changes = {}) {
  return {
    protocol: "ciaomind.goal-worker.v1",
    type: "task",
    namespace: "project",
    goal_id: "G1",
    goal_version: 1,
    step_id: "S1",
    task_id: "project/G1/S1",
    input_sha256: "a".repeat(64),
    attempt_id: "A1",
    worker,
    kind: "research",
    capability: "demo.compute",
    input: { operation: "sum", values: [3, 5, 8, 3] },
    objective: "Synthetic sum; $(touch never-run) is inert text",
    acceptance: ["Independently recompute the finite numeric sum"],
    grant: { namespace: "project", capability: "demo.compute" },
    lease_until: Date.now() + 60_000,
    idempotency_key: "demo-1",
    ...changes,
  };
}

function temp(t) {
  const path = mkdtempSync(join(tmpdir(), "ciaomind-adapter-test-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

function fakeCLI(directory) {
  const binary = join(directory, "fake-cli");
  writeFileSync(
    binary,
    "#!/usr/bin/env node\n" +
      [
        "const fs = require('node:fs');",
        "const args = process.argv.slice(2);",
        "if (args[0] === 'login') { process.stderr.write(process.env.TEST_AUTH === 'api' ? 'Logged in using an API key - private-test-secret' : 'Logged in using ChatGPT - private-test-secret'); process.exit(0); }",
        "const raw = fs.readFileSync(0, 'utf8');",
        "if (process.env.TEST_MODE === 'auth-failed') { process.stderr.write('HTTP 401 invalid_token private-test-secret'); process.exit(1); }",
        "if (process.env.TEST_PROVIDER_FAILURE) { process.stderr.write(process.env.TEST_PROVIDER_FAILURE); process.exit(1); }",
        "if (process.env.TEST_ARGS_FILE) fs.writeFileSync(process.env.TEST_ARGS_FILE, JSON.stringify({args,raw}));",
        "const start = raw.lastIndexOf('TASK PACKET:\\n\\n') + 'TASK PACKET:\\n\\n'.length;",
        "const finish = raw.indexOf('\\n\\nRESPONSE JSON SCHEMA:', start);",
        "const p = JSON.parse(finish < 0 ? raw.slice(start) : raw.slice(start, finish));",
        "const keys=['namespace','goal_id','goal_version','step_id','task_id','input_sha256','attempt_id'];",
        "const value=Object.fromEntries(keys.map(k=>[k,p[k]]));",
        "value.producer=p.worker; value.evidence=['Fixture only: no vendor or model was called'];",
        "if(p.type==='review')value.decision='accept';else value.output={summary:'Fixture computed 19',artifacts:[]};",
        "if(process.env.TEST_MODE==='bad-hash')value.input_sha256='wrong';",
        "if(process.env.TEST_MODE==='missing')delete value.attempt_id;",
        "let text=JSON.stringify(value);",
        "if(process.env.TEST_MODE==='invalid')text='not JSON';",
        "if(process.env.TEST_MODE==='large')text='x'.repeat(50000);",
        "const i=args.indexOf('--output-last-message');",
        "if(i>=0)fs.writeFileSync(args[i+1],text);else process.stdout.write(JSON.stringify({response:text,stats:{}}));",
      ].join("\n"),
    { mode: 0o700 },
  );
  return binary;
}

test("demo uses a real local subprocess and a separate reviewer recomputes canonical output", async () => {
  const worker = createDemoWorker();
  const p = packet();
  const result = await worker.run(p);
  assert.deepEqual(result.output, {
    demonstration: "local-demo-no-model",
    count: 4,
    sum: 19,
    sorted_unique: [3, 5, 8],
    summary: '{"count":4,"sum":19,"sorted_unique":[3,5,8]}',
  });
  // Database canonical JSON ordering must not cause an otherwise correct review to fail.
  result.output = {
    sum: 19,
    sorted_unique: [3, 5, 8],
    count: 4,
    demonstration: "local-demo-no-model",
    summary: '{"count":4,"sum":19,"sorted_unique":[3,5,8]}',
  };
  const reviewer = createDemoWorker({ id: "demo-reviewer" });
  const review = packet("demo-reviewer", {
    type: "review",
    capability: "review",
    grant: { namespace: "project", capability: "review" },
    result,
  });
  assert.equal((await reviewer.run(review)).decision, "accept");
  result.output.sum = 20;
  assert.equal((await reviewer.run(review)).decision, "reject");
});

test("registry labels demos explicitly and enforces namespace and capability grants", async () => {
  assert.throws(() => createDemoWorker({ id: "codex" }), {
    code: "INVALID_CONFIG",
  });
  assert.throws(
    () => createWorkerRegistry({ workers: [{ id: "a", type: "unknown" }] }),
    { code: "INVALID_CONFIG" },
  );
  const worker = createDemoWorker();
  await assert.rejects(
    worker.run(
      packet("demo-worker", {
        namespace: "personal",
        grant: { namespace: "personal", capability: "demo.compute" },
      }),
    ),
    { code: "NAMESPACE_DENIED" },
  );
  await assert.rejects(
    worker.run(
      packet("demo-worker", {
        grant: { namespace: "project", capability: "repo.write" },
      }),
    ),
    { code: "GRANT_REQUIRED" },
  );
  await assert.rejects(
    worker.run(packet("demo-worker", { capability: "repo.write" })),
    { code: "CAPABILITY_DENIED" },
  );
});

test("real workers are disabled without both explicit configuration and environment activation", async (t) => {
  const directory = temp(t);
  const binary = fakeCLI(directory);
  const options = { id: "codex", enabled: true, binary, workdir: directory };
  const p = packet("codex", {
    capability: "repo.read",
    grant: { namespace: "project", capability: "repo.read" },
  });
  await assert.rejects(
    createCodexWorker(options, {
      env: { ...process.env, CIAOMIND_ENABLE_WORKERS: "0" },
    }).run(p),
    { code: "WORKER_DISABLED" },
  );
  await assert.rejects(
    createCodexWorker(
      { ...options, enabled: false },
      { env: { ...process.env, CIAOMIND_ENABLE_WORKERS: "1" } },
    ).run(p),
    { code: "WORKER_DISABLED" },
  );
});

test("Codex fixture receives bounded read-only flags and packet via stdin, never shell arguments", async (t) => {
  const directory = temp(t);
  const binary = fakeCLI(directory);
  const argsPath = join(directory, "args.json");
  const env = {
    ...process.env,
    CIAOMIND_ENABLE_WORKERS: "1",
    TEST_ARGS_FILE: argsPath,
  };
  const worker = createCodexWorker(
    { id: "codex", enabled: true, binary, workdir: directory },
    { env },
  );
  const p = packet("codex", {
    capability: "repo.read",
    grant: { namespace: "project", capability: "repo.read" },
  });
  const result = await worker.run(p);
  assert.equal(result.producer, "codex");
  const invocation = JSON.parse(readFileSync(argsPath, "utf8"));
  assert(invocation.args.includes("--ignore-user-config"));
  assert(invocation.args.includes("--ephemeral"));
  assert.equal(
    invocation.args[invocation.args.indexOf("--sandbox") + 1],
    "read-only",
  );
  assert.equal(invocation.args[invocation.args.indexOf("-a") + 1], "never");
  assert(invocation.args.includes('web_search="disabled"'));
  assert(!invocation.args.some((s) => s.includes("dangerously")));
  assert(!invocation.args.some((s) => s.includes("$(touch")));
  assert(invocation.raw.includes("$(touch"));
  assert(!existsSync(join(directory, "never-run")));
  const schemaPath =
    invocation.args[invocation.args.indexOf("--output-schema") + 1];
  assert(
    !existsSync(schemaPath),
    "private response/schema directory is cleaned",
  );
  const diagnostic = await worker.doctor();
  assert.equal(diagnostic.auth, "chatgpt");
  assert(!JSON.stringify(diagnostic).includes("private-test-secret"));
});

test("Codex rejects API-key mode by default and refuses unreviewed project config", async (t) => {
  const directory = temp(t);
  const binary = fakeCLI(directory);
  const p = packet("codex", {
    capability: "repo.read",
    grant: { namespace: "project", capability: "repo.read" },
  });
  const env = {
    ...process.env,
    CIAOMIND_ENABLE_WORKERS: "1",
    TEST_AUTH: "api",
  };
  await assert.rejects(
    createCodexWorker(
      { id: "codex", enabled: true, binary, workdir: directory },
      { env },
    ).run(p),
    { code: "AUTH_MODE_NOT_ALLOWED" },
  );
  mkdirSync(join(directory, ".codex"));
  writeFileSync(join(directory, ".codex", "config.toml"), "");
  await assert.rejects(
    createCodexWorker(
      { id: "codex", enabled: true, binary, workdir: directory },
      { env: { ...env, TEST_AUTH: "chatgpt" } },
    ).run(p),
    { code: "CONFIG_REVIEW_REQUIRED" },
  );
});

test("Codex does not mistake its ignored global config for an ancestor project config", async (t) => {
  const directory = temp(t);
  const profile = join(directory, "profile");
  const globalDirectory = join(profile, ".codex");
  const workdir = join(profile, "AppData", "Local", "Temp", "probe");
  mkdirSync(globalDirectory, { recursive: true });
  mkdirSync(workdir, { recursive: true });
  const config = "# Synthetic global config, not a project layer\n";
  writeFileSync(join(globalDirectory, "config.toml"), config);
  const argsPath = join(directory, "args.json");
  const worker = createCodexWorker(
    { id: "codex", enabled: true, binary: fakeCLI(directory), workdir },
    {
      env: {
        ...process.env,
        CODEX_HOME: globalDirectory,
        CIAOMIND_ENABLE_WORKERS: "1",
        TEST_ARGS_FILE: argsPath,
      },
    },
  );
  const result = await worker.run(
    packet("codex", {
      capability: "repo.read",
      grant: { namespace: "project", capability: "repo.read" },
    }),
  );
  assert.equal(result.producer, "codex");
  const invocation = JSON.parse(readFileSync(argsPath, "utf8"));
  assert(invocation.args.includes("--ignore-user-config"));
  assert.equal(
    invocation.args[invocation.args.indexOf("--sandbox") + 1],
    "read-only",
  );
  assert.equal(readFileSync(join(globalDirectory, "config.toml"), "utf8"), config);
});

test("Codex does not exempt the parent home config when a child uses a different home", async (t) => {
  const directory = temp(t);
  const parentProfile = join(directory, "parent-profile");
  const childProfile = join(directory, "child-profile");
  const workdir = join(parentProfile, "nested", "work");
  mkdirSync(join(parentProfile, ".codex"), { recursive: true });
  mkdirSync(childProfile, { recursive: true });
  mkdirSync(workdir, { recursive: true });
  writeFileSync(
    join(parentProfile, ".codex", "config.toml"),
    "# Synthetic parent default; a project ancestor for the child\n",
  );
  const binary = fakeCLI(directory);
  const argsPath = join(directory, "args.json");
  const parentEnv = {
    ...process.env,
    HOME: parentProfile,
    USERPROFILE: parentProfile,
  };
  delete parentEnv.CODEX_HOME;
  const p = packet("codex", {
    capability: "repo.read",
    grant: { namespace: "project", capability: "repo.read" },
  });
  // Only this self-contained Node process gets a synthetic home. Neither this
  // test runner's environment nor the machine's real home is changed.
  const driver = `
    import { homedir } from "node:os";
    import { createCodexWorker } from ${JSON.stringify(new URL("./codex.mjs", import.meta.url).href)};
    const env = {
      ...process.env,
      HOME: ${JSON.stringify(childProfile)},
      USERPROFILE: ${JSON.stringify(childProfile)},
      CIAOMIND_ENABLE_WORKERS: "1",
      TEST_ARGS_FILE: ${JSON.stringify(argsPath)}
    };
    delete env.CODEX_HOME;
    const worker = createCodexWorker(
      { id: "codex", enabled: true, binary: ${JSON.stringify(binary)}, workdir: ${JSON.stringify(workdir)} },
      { env }
    );
    let code = null, notStarted = false;
    try { await worker.run(${JSON.stringify(p)}); }
    catch (error) { code = error.code; notStarted = error.notStarted; }
    console.log(JSON.stringify({ parent_home_is_fixture: homedir() === ${JSON.stringify(parentProfile)}, code, notStarted }));
  `;
  const result = await runProcess(process.execPath, ["--input-type=module", "-"], {
    input: driver,
    env: parentEnv,
    timeoutMs: 10_000,
  });
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout.trim()), {
    parent_home_is_fixture: true,
    code: "CONFIG_REVIEW_REQUIRED",
    notStarted: true,
  });
  assert(!existsSync(argsPath));
});

test("Codex still refuses an ancestor config outside its actual global directory", async (t) => {
  const directory = temp(t);
  const globalDirectory = join(directory, "global");
  const parent = join(directory, "workspace");
  const workdir = join(parent, "nested", "work");
  mkdirSync(globalDirectory, { recursive: true });
  mkdirSync(join(parent, ".codex"), { recursive: true });
  mkdirSync(workdir, { recursive: true });
  writeFileSync(join(parent, ".codex", "config.toml"), "# Synthetic project\n");
  const argsPath = join(directory, "args.json");
  const worker = createCodexWorker(
    { id: "codex", enabled: true, binary: fakeCLI(directory), workdir },
    {
      env: {
        ...process.env,
        CODEX_HOME: globalDirectory,
        CIAOMIND_ENABLE_WORKERS: "1",
        TEST_ARGS_FILE: argsPath,
      },
    },
  );
  await assert.rejects(
    worker.run(
      packet("codex", {
        capability: "repo.read",
        grant: { namespace: "project", capability: "repo.read" },
      }),
    ),
    { code: "CONFIG_REVIEW_REQUIRED", notStarted: true },
  );
  assert(!existsSync(argsPath));
});

test("a project config file alias does not inherit the ignored global directory exemption", async (t) => {
  const directory = temp(t);
  const globalDirectory = join(directory, "global");
  const workdir = join(directory, "workspace");
  const projectConfigDirectory = join(workdir, ".codex");
  mkdirSync(globalDirectory, { recursive: true });
  mkdirSync(projectConfigDirectory, { recursive: true });
  const globalConfig = join(globalDirectory, "config.toml");
  writeFileSync(globalConfig, "# Synthetic shared file, distinct config directory\n");
  linkSync(globalConfig, join(projectConfigDirectory, "config.toml"));
  const argsPath = join(directory, "args.json");
  const worker = createCodexWorker(
    { id: "codex", enabled: true, binary: fakeCLI(directory), workdir },
    {
      env: {
        ...process.env,
        CODEX_HOME: globalDirectory,
        CIAOMIND_ENABLE_WORKERS: "1",
        TEST_ARGS_FILE: argsPath,
      },
    },
  );
  await assert.rejects(
    worker.run(
      packet("codex", {
        capability: "repo.read",
        grant: { namespace: "project", capability: "repo.read" },
      }),
    ),
    { code: "CONFIG_REVIEW_REQUIRED", notStarted: true },
  );
  assert(!existsSync(argsPath));
});

test("Codex rejects incomplete, mismatched and oversized final responses", async (t) => {
  const directory = temp(t);
  const binary = fakeCLI(directory);
  const p = packet("codex", {
    capability: "repo.read",
    grant: { namespace: "project", capability: "repo.read" },
  });
  for (const [mode, code] of [
    ["missing", "RESULT_IDENTITY_MISMATCH"],
    ["bad-hash", "RESULT_IDENTITY_MISMATCH"],
    ["invalid", "INVALID_RESULT"],
    ["large", "OUTPUT_LIMIT"],
  ]) {
    const worker = createCodexWorker(
      {
        id: "codex",
        enabled: true,
        binary,
        workdir: directory,
        maxOutputBytes: 2000,
      },
      {
        env: { ...process.env, CIAOMIND_ENABLE_WORKERS: "1", TEST_MODE: mode },
      },
    );
    await assert.rejects(worker.run(p), { code });
  }
});

test("Gemini requires reviewed settings and validates its documented JSON response envelope", async (t) => {
  const directory = temp(t);
  const binary = fakeCLI(directory);
  const env = { ...process.env, CIAOMIND_ENABLE_WORKERS: "1" };
  const p = packet("gemini", {
    capability: "reasoning",
    grant: { namespace: "project", capability: "reasoning" },
  });
  await assert.rejects(
    createGeminiWorker(
      { id: "gemini", enabled: true, binary, workdir: directory },
      { env },
    ).run(p),
    { code: "CONFIG_REVIEW_REQUIRED" },
  );
  const worker = createGeminiWorker(
    {
      id: "gemini",
      enabled: true,
      binary,
      workdir: directory,
      reviewedConfig: true,
    },
    { env },
  );
  assert.equal((await worker.run(p)).producer, "gemini");
  const bad = createGeminiWorker(
    {
      id: "gemini",
      enabled: true,
      binary,
      workdir: directory,
      reviewedConfig: true,
    },
    { env: { ...env, TEST_MODE: "missing" } },
  );
  await assert.rejects(bad.run(p), { code: "RESULT_IDENTITY_MISMATCH" });
});

test("process timeout, cancellation and output cap terminate child execution", async () => {
  await assert.rejects(
    runProcess(process.execPath, ["-e", "setTimeout(()=>{},5000)"], {
      timeoutMs: 30,
    }),
    { code: "TIMEOUT" },
  );
  const abort = new AbortController();
  const pending = runProcess(
    process.execPath,
    ["-e", "setTimeout(()=>{},5000)"],
    { signal: abort.signal, timeoutMs: 5000 },
  );
  abort.abort();
  await assert.rejects(pending, { code: "ABORTED" });
  await assert.rejects(
    runProcess(
      process.execPath,
      ["-e", 'process.stdout.write("x".repeat(50000))'],
      { maxOutputBytes: 1000 },
    ),
    { code: "OUTPUT_LIMIT" },
  );
});

test("doctor reports missing executables without inventing successful authentication", async (t) => {
  const directory = temp(t);
  const reports = await doctorRegistry({
    workers: [
      {
        id: "gemini",
        type: "gemini",
        enabled: false,
        workdir: directory,
        binary: join(directory, "absent"),
      },
    ],
  });
  assert.equal(reports[0].installed, false);
  assert.equal(reports[0].reason, "BINARY_MISSING");
  assert.equal(reports[0].auth, "unverified");
  const p = packet();
  assert.throws(
    () =>
      validateResult(
        { ...p, producer: "demo-worker", output: {}, evidence: [] },
        p,
        "demo-worker",
      ),
    { code: "INVALID_RESULT" },
  );
});

test("provider failures expose only safe diagnostic categories and retain started invocation accounting", async (t) => {
  const directory = temp(t);
  const binary = fakeCLI(directory);
  const worker = createCodexWorker(
    { id: "codex", enabled: true, binary, workdir: directory },
    {
      env: {
        ...process.env,
        CIAOMIND_ENABLE_WORKERS: "1",
        TEST_MODE: "auth-failed",
      },
    },
  );
  const p = packet("codex", {
    capability: "repo.read",
    grant: { namespace: "project", capability: "repo.read" },
  });
  await assert.rejects(worker.run(p), (error) => {
    assert.equal(error.code, "AUTH_REQUIRED");
    assert.equal(error.retryable, false);
    assert.equal(error.notStarted, false);
    assert.deepEqual(error.diagnostic, {
      provider: "codex",
      http_status: 401,
      error_code: "invalid_token",
    });
    assert(!JSON.stringify(error).includes("private-test-secret"));
    assert(!error.message.includes("private-test-secret"));
    return true;
  });
});

const ACCOUNT_IDENTITY_REFRESH_FAILURE =
  "Your access token could not be refreshed because you have since logged out or signed in to another account. Please sign in again.";

function codexFailureWorker(t, failure) {
  const directory = temp(t);
  return createCodexWorker(
    {
      id: "codex",
      enabled: true,
      binary: fakeCLI(directory),
      workdir: directory,
    },
    {
      env: {
        ...process.env,
        CIAOMIND_ENABLE_WORKERS: "1",
        TEST_PROVIDER_FAILURE: failure,
      },
    },
  );
}

const codexFailurePacket = () =>
  packet("codex", {
    capability: "repo.read",
    grant: { namespace: "project", capability: "repo.read" },
  });

test("Codex account identity refresh failure is terminal without an HTTP status", async (t) => {
  const worker = codexFailureWorker(t, ACCOUNT_IDENTITY_REFRESH_FAILURE);
  await assert.rejects(worker.run(codexFailurePacket()), (error) => {
    assert.equal(error.code, "AUTH_REQUIRED");
    assert.equal(error.retryable, false);
    assert.equal(error.notStarted, false);
    assert.deepEqual(error.diagnostic, {
      provider: "codex",
      http_status: null,
      error_code: "unclassified",
      auth_failure_reason: "account_identity_mismatch",
      recovery_action: "sign_in_again",
    });
    assert.match(error.message, /official Codex login flow on the worker host/);
    assert(!error.message.includes(ACCOUNT_IDENTITY_REFRESH_FAILURE));
    return true;
  });
});

test("Codex identity recovery preserves the upstream 401 category and redacts raw secrets", async (t) => {
  const worker = codexFailureWorker(
    t,
    `HTTP 401 Unauthorized: ${ACCOUNT_IDENTITY_REFRESH_FAILURE} private-test-secret`,
  );
  await assert.rejects(worker.run(codexFailurePacket()), (error) => {
    assert.equal(error.code, "AUTH_REQUIRED");
    assert.equal(error.retryable, false);
    assert.deepEqual(error.diagnostic, {
      provider: "codex",
      http_status: 401,
      error_code: "unauthorized",
      auth_failure_reason: "account_identity_mismatch",
      recovery_action: "sign_in_again",
    });
    assert(!JSON.stringify(error).includes("private-test-secret"));
    assert(!error.message.includes("private-test-secret"));
    assert(!error.message.includes(ACCOUNT_IDENTITY_REFRESH_FAILURE));
    return true;
  });
});

test("explicit expired or invalidated refresh-token codes require sign-in without automatic retry", async (t) => {
  for (const code of ["refresh_token_expired", "refresh_token_invalidated"]) {
    const worker = codexFailureWorker(t, `${code} private-test-secret`);
    await assert.rejects(worker.run(codexFailurePacket()), (error) => {
      assert.equal(error.code, "AUTH_REQUIRED");
      assert.equal(error.retryable, false);
      assert.equal(error.notStarted, false);
      assert.deepEqual(error.diagnostic, {
        provider: "codex",
        http_status: null,
        error_code: code,
        recovery_action: "sign_in_again",
      });
      assert.match(error.message, /official Codex login flow on the worker host/);
      assert(!JSON.stringify(error).includes("private-test-secret"));
      assert(!error.message.includes("private-test-secret"));
      return true;
    });
  }
});

test("demo mission planning review has distinct phase identity and mission evaluation checks real child evidence", async () => {
  const worker = createDemoWorker();
  const reviewer = createDemoWorker({ id: "demo-reviewer" });
  const plannerPacket = packet("demo-worker", {
    step_id: "plan",
    task_id: "project/G1/plan",
    capability: "demo.plan",
    grant: { namespace: "project", capability: "demo.plan" },
    input: { operation: "plan-mission" },
  });
  const plan = await worker.run(plannerPacket);
  assert.equal(
    JSON.parse(plan.output.summary).steps[0].capability,
    "demo.compute",
  );
  const reviewPacket = packet("demo-reviewer", {
    type: "review",
    step_id: "review-plan",
    task_id: "project/G1/review-plan",
    input_sha256: "b".repeat(64),
    attempt_id: "A2",
    capability: "review",
    grant: { namespace: "project", capability: "review" },
    input: { operation: "review-plan" },
    result: plan,
  });
  const reviewed = await reviewer.run(reviewPacket);
  assert.equal(reviewed.decision, "accept");
  assert.equal(reviewed.attempt_id, "A2");
  assert.equal(reviewed.task_id, "project/G1/review-plan");
  const childPacket = packet();
  const result = await worker.run(childPacket);
  const review = await reviewer.run(
    packet("demo-reviewer", {
      type: "review",
      capability: "review",
      grant: { namespace: "project", capability: "review" },
      result,
    }),
  );
  const goal = {
    namespace: "project",
    goal_id: "child-1",
    status: "completed",
    steps: [
      {
        step_id: "compute",
        input: childPacket.input,
        status: "done",
        result,
        review,
      },
    ],
  };
  const evaluate = packet("demo-reviewer", {
    type: "review",
    step_id: "evaluate",
    task_id: "project/G1/evaluate",
    input: { operation: "evaluate-mission" },
    capability: "review",
    grant: { namespace: "project", capability: "review" },
    result: goal,
  });
  assert.equal((await reviewer.run(evaluate)).decision, "accept");
  goal.steps[0].result.output.sum = 999;
  assert.equal((await reviewer.run(evaluate)).decision, "reject");
});
