import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  statSync,
  rmSync,
  existsSync,
  realpathSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import {
  WorkerError,
  preflight,
  assertPacket,
  validateResult,
  responseSchema,
  makePrompt,
  safeFailureDiagnostic,
} from "./protocol.mjs";
import { findBinary, runProcess, workdirPath } from "./process.mjs";

const SECURITY =
  "read-only Codex sandbox; user config and optional external tools disabled; managed policy and host read scope still require operator review";

function ignoredGlobalConfigDirectory(env) {
  let configuredHome = env.CODEX_HOME;
  if (!configuredHome) {
    // homedir() describes this Node process. A child with a different home
    // environment may treat that same directory as project-local instead.
    if (
      ["HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH"].some(
        (name) => env[name] !== process.env[name],
      )
    )
      return null;
    configuredHome = join(homedir(), ".codex");
  }
  // A relative override can resolve differently for login status and exec.
  // Do not exempt an ambiguous location from the project-config guard.
  if (typeof configuredHome !== "string" || !isAbsolute(configuredHome))
    return null;
  try {
    return realpathSync(configuredHome);
  } catch {
    return null;
  }
}

function isIgnoredGlobalConfigDirectory(directory, globalDirectory) {
  if (!globalDirectory) return false;
  try {
    // Codex excludes CODEX_HOME from project discovery after canonicalizing
    // directories. Compare directories, not config-file targets: a project's
    // config file may alias the global file and still be a project layer.
    return realpathSync(directory) === globalDirectory;
  } catch {
    return false;
  }
}

export function createCodexWorker(options = {}, { env = process.env } = {}) {
  const id = options.id ?? "codex";
  const adapter = {
    id,
    type: "codex",
    namespaces: options.namespaces ?? ["project"],
    capabilities: ["repo.read", "document.read", "reasoning", "review"],
    effects: "read-only",
    enabled: options.enabled === true && env.CIAOMIND_ENABLE_WORKERS === "1",
    security: SECURITY,
    async doctor() {
      const binary = findBinary(options.binary ?? "codex", env);
      if (!binary)
        return {
          id,
          type: "codex",
          enabled: adapter.enabled,
          installed: false,
          configured: false,
          auth: "missing",
          reason: "BINARY_MISSING",
          security: SECURITY,
        };
      let auth = "unverified";
      try {
        const status = await runProcess(binary, ["login", "status"], {
          env,
          timeoutMs: 10_000,
          maxOutputBytes: 32_000,
        });
        const text = `${status.stdout}\n${status.stderr}`;
        if (/logged in.*chatgpt/is.test(text)) auth = "chatgpt";
        else if (/logged in.*api.?key/is.test(text)) auth = "api-key";
        else if (
          status.code !== 0 ||
          /not logged|not authenticated/is.test(text)
        )
          auth = "missing";
      } catch {
        /* A diagnostic failure is not successful authentication. */
      }
      let configured = false;
      try {
        workdirPath(options.workdir);
        configured = true;
      } catch {
        /* report below */
      }
      const reason = !configured
        ? "WORKDIR_REQUIRED"
        : auth === "missing"
          ? "AUTH_REQUIRED"
          : auth === "api-key" && options.allowApiKey !== true
            ? "AUTH_MODE_NOT_ALLOWED"
            : auth === "unverified"
              ? "AUTH_UNVERIFIED"
              : null;
      return {
        id,
        type: "codex",
        enabled: adapter.enabled,
        installed: true,
        configured,
        auth,
        reason,
        security: SECURITY,
      };
    },
    async run(packet, { signal } = {}) {
      if (!adapter.enabled)
        throw preflight(
          "WORKER_DISABLED",
          "Enable this worker explicitly and set CIAOMIND_ENABLE_WORKERS=1",
        );
      assertPacket(packet, adapter);
      const status = await adapter.doctor();
      if (status.reason)
        throw preflight(status.reason, `Codex is not ready: ${status.reason}`);
      const cwd = workdirPath(options.workdir);
      // Project-local config can add tools independently of the global config.
      // The exact global directory is already excluded by --ignore-user-config.
      const globalConfigDirectory = ignoredGlobalConfigDirectory(env);
      for (let directory = cwd; ; directory = dirname(directory)) {
        const configDirectory = join(directory, ".codex");
        if (
          existsSync(join(configDirectory, "config.toml")) &&
          !isIgnoredGlobalConfigDirectory(configDirectory, globalConfigDirectory)
        )
          throw preflight(
            "CONFIG_REVIEW_REQUIRED",
            "Project-local Codex config requires separate review before this bounded adapter can run",
          );
        if (dirname(directory) === directory) break;
      }
      const binary = findBinary(options.binary ?? "codex", env);
      const directory = mkdtempSync(join(tmpdir(), "ciaomind-codex-"));
      const schemaPath = join(directory, "response-schema.json");
      const outputPath = join(directory, "response.json");
      writeFileSync(schemaPath, JSON.stringify(responseSchema(packet)), {
        mode: 0o600,
      });
      const args = ["--no-daemon", "-a", "never"];
      for (const feature of [
        "apps",
        "plugins",
        "hooks",
        "browser_use",
        "computer_use",
        "image_generation",
        "multi_agent",
      ])
        args.push("--disable", feature);
      args.push(
        "exec",
        "--ignore-user-config",
        "--ephemeral",
        "--sandbox",
        "read-only",
        "-c",
        'web_search="disabled"',
        "--json",
        "--output-schema",
        schemaPath,
        "--output-last-message",
        outputPath,
        "-C",
        cwd,
        "--skip-git-repo-check",
      );
      if (options.model) args.push("--model", options.model);
      args.push("-");
      const maxOutputBytes = options.maxOutputBytes ?? 2_000_000;
      try {
        const result = await runProcess(binary, args, {
          input: makePrompt(packet),
          cwd,
          env,
          signal,
          timeoutMs: options.timeoutMs ?? 120_000,
          maxOutputBytes,
        });
        if (result.code !== 0) {
          const text = `${result.stdout}\n${result.stderr}`;
          const diagnostic = safeFailureDiagnostic(text, "codex");
          const authError =
            [401, 403].includes(diagnostic.http_status) ||
            [
              "invalid_api_key",
              "invalid_token",
              "token_expired",
              "refresh_token_invalidated",
              "refresh_token_expired",
              "refresh_token_reused",
              "unauthorized",
              "authentication_error",
              "account_deactivated",
            ].includes(diagnostic.error_code) ||
            diagnostic.auth_failure_reason === "account_identity_mismatch" ||
            /not logged in|login required|please sign in/i.test(text);
          const recovery =
            diagnostic.recovery_action === "sign_in_again"
              ? " Sign in again using the official Codex login flow on the worker host before retrying."
              : "";
          const error = new WorkerError(
            authError ? "AUTH_REQUIRED" : "WORKER_FAILED",
            `Codex exited without a valid result (exit ${result.code}; HTTP ${diagnostic.http_status ?? "unknown"}; ${diagnostic.error_code}).${recovery}`,
            { retryable: !authError },
          );
          error.diagnostic = diagnostic;
          throw error;
        }
        if (!existsSync(outputPath))
          throw new WorkerError(
            "INVALID_RESULT",
            "Codex did not produce a final structured response",
          );
        if (statSync(outputPath).size > maxOutputBytes)
          throw new WorkerError(
            "OUTPUT_LIMIT",
            "Codex response file exceeds the configured limit",
          );
        let parsed;
        try {
          parsed = JSON.parse(readFileSync(outputPath, "utf8"));
        } catch {
          throw new WorkerError(
            "INVALID_RESULT",
            "Codex response is not a JSON object",
          );
        }
        return validateResult(parsed, packet, id);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  };
  return adapter;
}
