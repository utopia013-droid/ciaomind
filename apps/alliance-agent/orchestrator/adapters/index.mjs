import { createCodexWorker } from "./codex.mjs";
import { createGeminiWorker } from "./gemini.mjs";
import { createDemoWorker } from "./demo.mjs";
import { WorkerError } from "./protocol.mjs";

export { createCodexWorker, createGeminiWorker, createDemoWorker, WorkerError };
export { validateResult, responseSchema } from "./protocol.mjs";

export function createWorkerRegistry(config, options = {}) {
  const definitions = Array.isArray(config) ? config : config?.workers;
  if (!Array.isArray(definitions))
    throw new WorkerError(
      "INVALID_CONFIG",
      "Configuration requires a workers array",
    );
  const registry = Object.create(null);
  for (const definition of definitions) {
    if (
      !definition ||
      typeof definition.id !== "string" ||
      !/^[a-z][a-z0-9._-]{0,63}$/.test(definition.id) ||
      Object.hasOwn(registry, definition.id)
    ) {
      throw new WorkerError(
        "INVALID_CONFIG",
        "Worker IDs must be unique lowercase audit labels",
      );
    }
    const factory = {
      codex: createCodexWorker,
      gemini: createGeminiWorker,
      demo: createDemoWorker,
    }[definition.type];
    if (!factory)
      throw new WorkerError("INVALID_CONFIG", "Unknown worker adapter type");
    registry[definition.id] = factory(definition, options);
  }
  return registry;
}

export async function doctorRegistry(config, options = {}) {
  const registry = createWorkerRegistry(config, options);
  return Promise.all(
    Object.values(registry).map((adapter) => adapter.doctor()),
  );
}
