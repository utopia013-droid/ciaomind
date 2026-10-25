import { defineTool } from "eve/tools";
import { z } from "zod";
import { withMissions } from "../lib/missions.js";

export default defineTool({
  description:
    "Apply the user's explicit pause, resume or cancel instruction to a mission. This cannot rewrite the objective, expand grants, reset spent call reservations or approve an agent's own output.",
  inputSchema: z.object({
    namespace: z.enum(["personal", "project"]),
    mission_id: z.string().min(1).max(100),
    action: z.enum(["pause", "resume", "cancel"]),
  }),
  execute({ namespace, mission_id, action }) {
    return withMissions((store) => {
      if (action === "pause") return store.pauseMission(namespace, mission_id);
      if (action === "resume")
        return store.resumeMission(namespace, mission_id);
      return store.cancelMission(namespace, mission_id);
    });
  },
});
