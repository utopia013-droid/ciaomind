import { defineTool } from "eve/tools";
import { z } from "zod";
import { withGoals } from "../lib/goals.js";

export default defineTool({
  description:
    "Apply an explicit user instruction to pause, resume, cancel or retry a local goal. Retry cannot grant permissions or expand budgets. This tool does not execute workers or edit the objective/acceptance contract.",
  inputSchema: z.object({
    namespace: z.enum(["personal", "project"]),
    goal_id: z.string().min(1).max(100),
    action: z.enum(["pause", "resume", "cancel", "retry"]),
    step_id: z.string().optional(),
  }),
  execute({ namespace, goal_id, action, step_id }) {
    return withGoals((store) => {
      if (action === "pause") return store.pauseGoal(namespace, goal_id);
      if (action === "resume") return store.resumeGoal(namespace, goal_id);
      if (action === "cancel") return store.cancelGoal(namespace, goal_id);
      return store.retryBlocked(namespace, goal_id, { step_id });
    });
  },
});
