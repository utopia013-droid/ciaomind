import { defineTool } from "eve/tools";
import { z } from "zod";
import { withGoals } from "../lib/goals.js";

export default defineTool({
  description:
    "Read persistent goals or one goal's result and audit trail within an explicitly selected namespace. Report blocked reasons, remaining call reservations and next wake times without inventing progress.",
  inputSchema: z.object({
    namespace: z.enum(["personal", "project"]),
    goal_id: z.string().min(1).max(100).optional(),
  }),
  execute({ namespace, goal_id }) {
    return withGoals((store) =>
      goal_id
        ? {
            goal: store.getGoal(namespace, goal_id),
            events: store.events(namespace, goal_id),
          }
        : { goals: store.listGoals(namespace) },
    );
  },
});
