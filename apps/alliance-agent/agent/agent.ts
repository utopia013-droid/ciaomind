import { defineAgent, defineDynamic } from "eve";

function enabledModel() {
  if (process.env.CIAOMIND_ENABLE_MODEL !== "1") {
    throw new Error("Model access is disabled. Verify credentials and budget, then set CIAOMIND_ENABLE_MODEL=1 explicitly.");
  }
  return "openai/gpt-6-luna-fast";
}

export default defineAgent({
  // Keep the scaffold's selected model, but do not activate inference implicitly.
  model: defineDynamic({
    events: {
      "session.started": enabledModel,
      "step.started": enabledModel,
    },
  }),
  reasoning: "high",
  defaultTools: false,
  tool: false,
});
