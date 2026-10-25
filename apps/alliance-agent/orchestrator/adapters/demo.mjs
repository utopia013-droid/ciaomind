import { fileURLToPath } from "node:url";
import {
  WorkerError,
  preflight,
  assertPacket,
  validateResult,
} from "./protocol.mjs";
import { runProcess } from "./process.mjs";

export function createDemoWorker(options = {}) {
  const id = options.id ?? "demo-worker";
  if (!id.startsWith("demo-"))
    throw new WorkerError(
      "INVALID_CONFIG",
      "Demo worker IDs must start with demo-",
    );
  const adapter = {
    id,
    type: "demo",
    namespaces: options.namespaces ?? ["project"],
    capabilities: ["demo.compute", "demo.plan", "review"],
    effects: "read-only",
    enabled: options.enabled !== false,
    async doctor() {
      return {
        id,
        type: "demo",
        enabled: adapter.enabled,
        installed: true,
        configured: true,
        auth: "not-required-demo",
        reason: null,
        security: "synthetic JSON-only local subprocess; no model",
      };
    },
    async run(packet, { signal } = {}) {
      if (!adapter.enabled)
        throw preflight("WORKER_DISABLED", "Demo worker is disabled");
      assertPacket(packet, adapter);
      const result = await runProcess(
        process.execPath,
        [fileURLToPath(new URL("./demo-worker.mjs", import.meta.url))],
        {
          input: JSON.stringify(packet),
          signal,
          timeoutMs: options.timeoutMs ?? 5_000,
          maxOutputBytes: options.maxOutputBytes ?? 1_000_000,
        },
      );
      if (result.code !== 0)
        throw new WorkerError(
          "DEMO_INPUT_UNSUPPORTED",
          "Demo worker only accepts supported synthetic JSON operations",
        );
      let parsed;
      try {
        parsed = JSON.parse(result.stdout);
      } catch {
        throw new WorkerError(
          "INVALID_RESULT",
          "Demo subprocess returned malformed JSON",
        );
      }
      return validateResult(parsed, packet, id);
    },
  };
  return adapter;
}
