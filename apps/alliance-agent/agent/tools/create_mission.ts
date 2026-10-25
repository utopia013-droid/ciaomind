import { defineTool } from "eve/tools";
import { z } from "zod";
import { withMissions } from "../lib/missions.js";

export default defineTool({
  description:
    "Register the user's long-term objective and fixed acceptance criteria. The independently running mission director will plan, delegate, review and replan within the immutable grants, allowed workers and call/cycle limits. This does not start a daemon or prove external connections. Use worker_status first; do not invent worker IDs or authorization.",
  inputSchema: z.object({
    mission_id: z.string().min(1).max(100),
    namespace: z.enum(["personal", "project"]),
    mode: z.enum(["live", "demo"]).default("live"),
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
    planner: z.string().min(1).max(100),
    reviewer: z.string().min(1).max(100),
    allowed_workers: z.array(z.string().min(1)).min(2).max(12),
    max_calls: z.number().int().min(5).max(100).default(12),
    max_cycles: z.number().int().min(1).max(5).default(2),
    revisit_seconds: z.number().int().min(0).max(604800).default(0),
  }),
  execute(input) {
    return withMissions((store) => store.createMission(input));
  },
});
