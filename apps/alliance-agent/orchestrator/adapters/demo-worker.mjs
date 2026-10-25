// Explicit deterministic protocol demonstrator; no model, vendor or remote identity.
import { readFileSync } from "node:fs";
import { identity } from "./protocol.mjs";

function compute(input) {
  if (
    input?.operation === "sum" &&
    Array.isArray(input.values) &&
    input.values.length <= 10_000 &&
    input.values.every((n) => typeof n === "number" && Number.isFinite(n))
  ) {
    const sum = input.values.reduce((a, b) => a + b, 0);
    if (!Number.isFinite(sum)) throw new Error("Sum is non-finite");
    const data = {
      count: input.values.length,
      sum,
      sorted_unique: [...new Set(input.values)].sort((a, b) => a - b),
    };
    return {
      demonstration: "local-demo-no-model",
      ...data,
      summary: JSON.stringify(data),
    };
  }
  if (input?.operation === "inspect") {
    return {
      demonstration: "local-demo-no-model",
      summary: "Inspected synthetic JSON only",
      keys: Object.keys(input).sort(),
    };
  }
  if (["plan-mission", "review-plan"].includes(input?.operation)) {
    const plan = {
      steps: [
        {
          step_id: "compute",
          kind: "research",
          worker: "demo-worker",
          reviewer: "demo-reviewer",
          capability: "demo.compute",
          input: { operation: "sum", values: [3, 5, 8] },
          depends_on: [],
        },
      ],
    };
    return {
      demonstration: "local-demo-no-model",
      summary: JSON.stringify(plan),
      artifacts: [],
    };
  }
  throw new Error("Demo accepts operation sum with finite values, or inspect");
}

function evaluateMission(packet) {
  const goal = packet.result;
  if (
    !goal ||
    goal.namespace !== packet.namespace ||
    goal.status !== "completed" ||
    !Array.isArray(goal.steps) ||
    !goal.steps.length
  )
    return false;
  return goal.steps.every((step) => {
    if (
      step.status !== "done" ||
      step.input?.operation !== "sum" ||
      step.review?.decision !== "accept"
    )
      return false;
    if (
      step.result?.producer === step.review?.producer ||
      !step.result?.producer ||
      !step.review?.producer
    )
      return false;
    try {
      return canonical(step.result.output) === canonical(compute(step.input));
    } catch {
      return false;
    }
  });
}

function canonical(value) {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map((key) => JSON.stringify(key) + ":" + canonical(value[key]))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}

try {
  const packet = JSON.parse(readFileSync(0, "utf8"));
  const result = { ...identity(packet), producer: packet.worker };
  if (
    packet.type === "review" &&
    packet.input?.operation === "evaluate-mission"
  ) {
    const accepts = evaluateMission(packet);
    Object.assign(result, {
      decision: accepts ? "accept" : "reject",
      evidence: [
        accepts
          ? "Demo mission evaluator independently recomputed every synthetic sum and checked done states with distinct accepting reviewers; no natural-language objective or model capability is proven."
          : "Synthetic child goal is incomplete or its independent result evidence does not match.",
      ],
    });
  } else if (
    packet.type === "review" &&
    packet.input?.operation === "review-plan"
  ) {
    const actual = packet.result;
    // Mission planning and its review have separate task/attempt/hash identities.
    // The director validates the original planning receipt before this call.
    const independent =
      actual &&
      actual.producer !== packet.worker &&
      actual.namespace === packet.namespace &&
      actual.goal_id === packet.goal_id &&
      actual.goal_version === packet.goal_version &&
      typeof actual.attempt_id === "string" &&
      actual.attempt_id.length > 0;
    const matches =
      independent &&
      canonical(actual.output) === canonical(compute(packet.input));
    Object.assign(result, {
      decision: matches ? "accept" : "reject",
      evidence: [
        matches
          ? "Independent demo plan review matched the fixed synthetic plan across distinct planning/review task identities; this does not assess a real natural-language objective."
          : "Synthetic plan or mission/producer identity did not match.",
      ],
    });
  } else if (packet.type === "review") {
    const expected = compute(packet.input);
    const actual = packet.result;
    const independent =
      actual &&
      actual.producer !== packet.worker &&
      actual.namespace === packet.namespace &&
      actual.goal_id === packet.goal_id &&
      actual.goal_version === packet.goal_version &&
      actual.step_id === packet.step_id &&
      actual.task_id === packet.task_id &&
      actual.input_sha256 === packet.input_sha256;
    const matches =
      independent && canonical(actual.output) === canonical(expected);
    Object.assign(result, {
      decision: matches ? "accept" : "reject",
      evidence: [
        matches
          ? "Independent deterministic demo recomputation matches; no model or remote authentication was used."
          : "Demo recomputation or producer/identity check did not match.",
      ],
    });
  } else
    Object.assign(result, {
      output: compute(packet.input),
      evidence: [
        "Deterministic local subprocess computed from packet.input; this is a demo, not a connected vendor worker.",
      ],
    });
  process.stdout.write(JSON.stringify(result));
} catch {
  process.stderr.write("Demo input is unsupported or malformed\n");
  process.exitCode = 1;
}
