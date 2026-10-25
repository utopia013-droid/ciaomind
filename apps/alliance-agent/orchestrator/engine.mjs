import { randomUUID } from "node:crypto";
import { fault } from "./store.mjs";

/** Deterministic scheduler. It never invents tasks, grants, credentials or acceptance criteria. */
export class Coordinator {
  constructor({
    store,
    workers,
    now,
    owner = randomUUID(),
    leaseMs = 120000,
    maxActionsPerTick = 20,
  }) {
    if (!store || !workers)
      throw fault("INVALID_CONFIG", "store and workers are required");
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 10 || leaseMs > 3600000)
      throw fault("INVALID_CONFIG", "leaseMs must be 10–3600000");
    if (
      !Number.isSafeInteger(maxActionsPerTick) ||
      maxActionsPerTick < 1 ||
      maxActionsPerTick > 100
    )
      throw fault("INVALID_CONFIG", "maxActionsPerTick must be 1–100");
    if (now !== undefined) store._useClock(now);
    this.store = store;
    this.workers = workers;
    this.owner = owner;
    this.leaseMs = leaseMs;
    this.maxActionsPerTick = maxActionsPerTick;
  }
  #worker(id) {
    return this.workers instanceof Map
      ? this.workers.get(id)
      : Object.hasOwn(this.workers, id)
        ? this.workers[id]
        : undefined;
  }
  #eligible(step, phase, goal, details = false) {
    const id = phase === "review" ? step.reviewer : step.worker,
      capability = phase === "review" ? "review" : step.capability;
    let error;
    if (phase === "review" && !id)
      error = {
        code: "REVIEWER_REQUIRED",
        message: "Configure an independent reviewer",
      };
    else if (phase === "review" && id === step.worker)
      error = {
        code: "SELF_REVIEW",
        message: "Worker and reviewer must be different registry identities",
      };
    else if (!goal.grants.includes(capability))
      error = {
        code: "GRANT_DENIED",
        message: `Goal does not authorize ${capability}`,
      };
    const worker = id ? this.#worker(id) : undefined;
    if (!error && !worker)
      error = {
        code: "WORKER_UNAVAILABLE",
        message: `No registered adapter ${id}`,
      };
    if (!error && (!worker.enabled || typeof worker.run !== "function"))
      error = {
        code: "WORKER_DISABLED",
        message: `Adapter ${id} is disabled or not configured`,
      };
    if (
      !error &&
      (!Array.isArray(worker.namespaces) ||
        !worker.namespaces.includes(goal.namespace))
    )
      error = {
        code: "NAMESPACE_DENIED",
        message: `Adapter ${id} is not authorized for ${goal.namespace}`,
      };
    if (
      !error &&
      (!Array.isArray(worker.capabilities) ||
        !(
          worker.capabilities.includes(capability) ||
          worker.capabilities.includes("*")
        ))
    )
      error = {
        code: "CAPABILITY_DENIED",
        message: `Adapter ${id} cannot provide ${capability}`,
      };
    if (!error && !["read-only", "write"].includes(worker.effects))
      error = {
        code: "INVALID_CONFIG",
        message: `Adapter ${id} must declare effects`,
      };
    if (!error && phase === "review" && worker.effects !== "read-only")
      error = {
        code: "REVIEWER_EFFECTS",
        message: "Review adapters must be read-only",
      };
    return error ?? (details ? { effects: worker.effects } : null);
  }
  async #run(claim, signal) {
    const controller = new AbortController();
    let timer, abort;
    const adapter = this.#worker(claim.packet.worker);
    const deadline = new Promise((_, reject) => {
      abort = () => {
        controller.abort(signal?.reason);
        const error = fault(
          "ABORTED",
          "Coordinator stopping; in-flight outcome needs reconciliation",
        );
        error.retryable = true;
        reject(error);
      };
      signal?.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => {
        controller.abort();
        const error = fault("LEASE_TIMEOUT", "Worker exceeded its lease");
        error.retryable = true;
        reject(error);
      }, this.leaseMs);
      if (signal?.aborted) abort();
    });
    try {
      const result = await Promise.race([
        Promise.resolve().then(() => {
          if (controller.signal.aborted) {
            const error = fault("ABORTED", "Call cancelled before invocation");
            error.notStarted = true;
            throw error;
          }
          return adapter.run(claim.packet, { signal: controller.signal });
        }),
        deadline,
      ]);
      if (controller.signal.aborted)
        throw fault("ABORTED", "Ignore late result after cancellation");
      return result;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }
  async tick({ namespace, signal } = {}) {
    const summary = {
      goals_scanned: 0,
      task_calls: 0,
      review_calls: 0,
      completed_steps: 0,
      blocked_steps: 0,
      recovered_leases: 0,
      maintenance_checks: 0,
      errors: [],
    };
    if (signal?.aborted) return summary;
    summary.recovered_leases = this.store._recoverExpired(namespace);
    const goals = this.store.listGoals(namespace);
    summary.goals_scanned = goals.length;
    for (const first of goals) {
      if (signal?.aborted) break;
      try {
        if (
          this.store._maintenance(
            first.namespace,
            first.goal_id,
            this.#eligible.bind(this),
          )
        )
          summary.maintenance_checks++;
        for (
          let count = 0;
          count < this.maxActionsPerTick && !signal?.aborted;
          count++
        ) {
          const claim = this.store._claim(first.namespace, first.goal_id, {
            owner: this.owner,
            leaseMs: this.leaseMs,
            eligible: this.#eligible.bind(this),
          });
          if (!claim) break;
          if (claim.phase === "task") summary.task_calls++;
          else summary.review_calls++;
          try {
            const result = await this.#run(claim, signal);
            this.store._finish(claim, result);
            if (claim.phase === "review" && result.decision === "accept")
              summary.completed_steps++;
          } catch (error) {
            const recorded = this.store._fail(claim, error);
            if (recorded && error?.notStarted === true) {
              if (claim.phase === "task") summary.task_calls--;
              else summary.review_calls--;
            }
            summary.errors.push({
              namespace: first.namespace,
              goal_id: first.goal_id,
              step_id: claim.packet.step_id,
              code: error?.code ?? "WORKER_ERROR",
              message: String(error?.message ?? error).slice(0, 1000),
            });
          }
        }
      } catch (error) {
        summary.errors.push({
          namespace: first.namespace,
          goal_id: first.goal_id,
          code: error?.code ?? "CONTROLLER_ERROR",
          message: String(error?.message ?? error).slice(0, 1000),
        });
      }
    }
    summary.blocked_steps = this.store
      .listGoals(namespace)
      .flatMap((g) => g.steps)
      .filter((s) => s.status === "blocked").length;
    return summary;
  }
}
