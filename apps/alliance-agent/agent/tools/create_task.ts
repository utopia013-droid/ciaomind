import { defineTool } from "eve/tools";
import { z } from "zod";
import { withControl } from "../lib/control.js";

export default defineTool({
  description: "Register a local task and compute its input fingerprint. Reuse the same task_id for retries. Sensitive tasks remain blocked for a human; this does not invoke a worker.",
  inputSchema: z.object({
    task_id: z.string().min(1).max(100),
    kind: z.enum(["code", "office", "research", "sensitive"]),
    input: z.record(z.string(), z.json()),
  }),
  execute(input) {
    return withControl((control) => control.createTask({ ...input, input_version: 1 }));
  },
});
