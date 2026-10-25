import { defineTool } from "eve/tools";
import { z } from "zod";
import { withControl } from "../lib/control.js";

export default defineTool({
  description: "Export a task's idempotent JSON packet for manual handoff. This only records a dispatch and returns data; it cannot contact or launch Codex, WorkBuddy or any model.",
  inputSchema: z.object({ task_id: z.string().min(1).max(100) }),
  execute({ task_id }) {
    return withControl((control) => control.dispatch(task_id));
  },
});
