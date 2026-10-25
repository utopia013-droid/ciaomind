import { defineTool } from "eve/tools";
import { z } from "zod";
import { withControl } from "../lib/control.js";

export default defineTool({
  description: "Read local task state and audit events, or list registered tasks. Identity fields are local assertions, and dispatch status is not remote execution evidence.",
  inputSchema: z.object({ task_id: z.string().min(1).max(100).optional() }),
  execute({ task_id }) {
    return withControl((control) => task_id
      ? { task: control.getTask(task_id), events: control.events(task_id) }
      : { tasks: control.listTasks() });
  },
});
