import { defineTool } from "eve/tools";
import { z } from "zod";
import { loadConfig } from "../../orchestrator/config.mjs";
import { doctorRegistry } from "../../orchestrator/adapters/index.mjs";

export default defineTool({
  description:
    "Inspect configured worker IDs and safe readiness information without invoking a model or exposing credentials. Availability, login readiness and a successfully completed real task are distinct states.",
  inputSchema: z.object({}),
  async execute() {
    return {
      workers: await doctorRegistry(loadConfig()),
      readiness_is_not_end_to_end_verification: true,
    };
  },
});
