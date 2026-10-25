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
  "Gemini plan mode and sandbox requested; operator must review local MCP/extensions/settings; this is not certified host or multi-tenant isolation";
export function createGeminiWorker(options = {}, { env = process.env } = {}) {
  const id = options.id ?? "gemini";
  const adapter = {
    id,
    type: "gemini",
    namespaces: options.namespaces ?? ["project"],
    capabilities: ["repo.read", "document.read", "reasoning", "review"],
    effects: "read-only",
    enabled: options.enabled === true && env.CIAOMIND_ENABLE_WORKERS === "1",
    security: SECURITY,
    async doctor() {
      const installed = !!findBinary(options.binary ?? "gemini", env);
      let configured = false;
      try {
        workdirPath(options.workdir);
        configured = true;
      } catch {
        /* metadata only */
      }
      return {
        id,
        type: "gemini",
        installed,
        configured,
        enabled: adapter.enabled,
        auth: "unverified",
        reason: !installed
          ? "BINARY_MISSING"
          : !configured
            ? "WORKDIR_REQUIRED"
            : options.reviewedConfig !== true
              ? "CONFIG_REVIEW_REQUIRED"
              : "AUTH_UNVERIFIED",
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
      if (options.reviewedConfig !== true)
        throw preflight(
          "CONFIG_REVIEW_REQUIRED",
          "Review Gemini MCP, extensions, hooks and settings before enabling this adapter",
        );
      const cwd = workdirPath(options.workdir);
      const binary = findBinary(options.binary ?? "gemini", env);
      if (!binary)
        throw preflight("BINARY_MISSING", "Gemini CLI is not installed");
      const args = [
        "--prompt",
        "Process the task packet from stdin and return only the requested JSON object.",
        "--output-format",
        "json",
        "--approval-mode",
        "plan",
        "--sandbox",
      ];
      if (options.model) args.push("--model", options.model);
      const input = `${makePrompt(packet)}\n\nRESPONSE JSON SCHEMA:\n${JSON.stringify(responseSchema(packet))}`;
      const result = await runProcess(binary, args, {
        input,
        cwd,
        env,
        signal,
        timeoutMs: options.timeoutMs ?? 120_000,
        maxOutputBytes: options.maxOutputBytes ?? 2_000_000,
      });
      if (result.code !== 0) {
        const text = result.stdout + result.stderr;
        const diagnostic = safeFailureDiagnostic(text, "gemini");
        const auth =
          [401, 403].includes(diagnostic.http_status) ||
          /auth|credential|api.?key|login|sign in/i.test(text);
        const error = new WorkerError(
          auth ? "AUTH_REQUIRED" : "WORKER_FAILED",
          `Gemini exited without a valid result (HTTP ${diagnostic.http_status ?? "unknown"}; ${diagnostic.error_code})`,
          { retryable: !auth },
        );
        error.diagnostic = diagnostic;
        throw error;
      }
      let wrapper;
      try {
        wrapper = JSON.parse(result.stdout);
      } catch {
        throw new WorkerError(
          result.code !== 0 ? "WORKER_FAILED" : "INVALID_RESULT",
          "Gemini did not return the documented JSON envelope",
        );
      }
      if (result.code !== 0 || wrapper.error) {
        const auth = /auth|credential|api.?key|login|sign in/i.test(
          JSON.stringify(wrapper.error ?? "") + result.stderr,
        );
        throw new WorkerError(
          auth ? "AUTH_REQUIRED" : "WORKER_FAILED",
          auth
            ? "Gemini authentication is unavailable"
            : "Gemini failed without an accepted result",
          { retryable: !auth },
        );
      }
      if (typeof wrapper.response !== "string")
        throw new WorkerError(
          "INVALID_RESULT",
          "Gemini envelope is missing response text",
        );
      let parsed;
      try {
        parsed = JSON.parse(wrapper.response);
      } catch {
        throw new WorkerError(
          "INVALID_RESULT",
          "Gemini response must be exact JSON without fences",
        );
      }
      return validateResult(parsed, packet, id);
    },
  };
  return adapter;
}
