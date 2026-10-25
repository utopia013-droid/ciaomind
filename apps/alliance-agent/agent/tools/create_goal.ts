import { defineTool } from "eve/tools";
import { z } from "zod";
import { withGoals } from "../lib/goals.js";

export default defineTool({
  description:
    "Create an immutable, persistent goal from the user's objective and an explicit plan. Keep personal and project namespaces separate. Only approved read capabilities are exposed here; this registers work for the separately configured daemon and does not prove any worker is connected.",
  inputSchema: z.object({
    goal_id: z.string().min(1).max(100),
    namespace: z.enum(["personal", "project"]),
    objective: z.string().min(1).max(4000),
    acceptance: z.array(z.string().min(1)).min(1).max(20),
    grants: z
      .array(
        z.enum([
          "repo.read",
          "document.read",
          "review",
          "demo.plan",
          "demo.compute",
        ]),
      )
      .min(1),
    max_calls: z.number().int().min(2).max(40).default(6),
    max_attempts: z.number().int().min(1).max(3).default(2),
    revisit_seconds: z.number().int().min(0).max(604800).default(0),
    steps: z
      .array(
        z.object({
          step_id: z.string().min(1).max(100),
          kind: z.enum(["code", "research", "office"]),
          worker: z.string().min(1).max(100),
          reviewer: z.string().min(1).max(100),
          capability: z.enum([
            "repo.read",
            "document.read",
            "demo.plan",
            "demo.compute",
          ]),
          input: z.record(z.string(), z.json()),
          depends_on: z.array(z.string()).default([]),
        }),
      )
      .min(1)
      .max(20),
  }),
  execute(input) {
    return withGoals((store) => store.createGoal(input));
  },
});
