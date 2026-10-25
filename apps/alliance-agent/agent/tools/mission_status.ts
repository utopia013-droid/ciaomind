import { defineTool } from "eve/tools";
import { z } from "zod";
import { readMissionChild, withMissions } from "../lib/missions.js";

export default defineTool({
  description:
    "Read one long-term mission's persisted phase, evidence, budget reservations and blocker, or list missions in one namespace. A completed child plan is not proof that the original mission has passed independent acceptance.",
  inputSchema: z.object({
    namespace: z.enum(["personal", "project"]),
    mission_id: z.string().min(1).max(100).optional(),
  }),
  execute({ namespace, mission_id }) {
    return withMissions((store) => {
      if (!mission_id) return { missions: store.listMissions(namespace) };
      const mission = store.getMission(namespace, mission_id);
      const events = store.events(namespace, mission_id);
      return {
        mission,
        child: mission.child_goal_id
          ? readMissionChild(namespace, mission.child_goal_id)
          : null,
        events: events.slice(-20),
        total_audit_events: events.length,
      };
    });
  },
});
