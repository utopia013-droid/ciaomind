/** Serial polling with bounded shutdown. Callbacks must not log private inputs. */
export async function runCoordinator({
  coordinator,
  namespace,
  intervalMs = 5000,
  maxTicks = Infinity,
  signal,
  shutdownTimeoutMs = 15000,
  onTick = () => {},
}) {
  if (!coordinator || typeof coordinator.tick !== "function")
    throw new TypeError("coordinator.tick is required");
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1)
    throw new TypeError("intervalMs must be positive");
  if (
    maxTicks !== Infinity &&
    (!Number.isSafeInteger(maxTicks) || maxTicks < 1)
  )
    throw new TypeError("maxTicks must be positive");
  if (!Number.isSafeInteger(shutdownTimeoutMs) || shutdownTimeoutMs < 1)
    throw new TypeError("shutdownTimeoutMs must be positive");
  let ticks = 0;
  let lastSummary = null;
  while (!signal?.aborted && ticks < maxTicks) {
    const controller = new AbortController();
    let timeout;
    let abort;
    const stopping = new Promise((_, reject) => {
      abort = () => {
        controller.abort(signal.reason);
        timeout = setTimeout(() => {
          const error = new Error(
            "Current tick did not stop within shutdown timeout; its persisted lease must be recovered before re-execution",
          );
          error.code = "SHUTDOWN_TIMEOUT";
          reject(error);
        }, shutdownTimeoutMs);
      };
      signal?.addEventListener("abort", abort, { once: true });
    });
    try {
      if (signal?.aborted) abort();
      lastSummary = await Promise.race([
        Promise.resolve().then(() =>
          coordinator.tick({ namespace, signal: controller.signal }),
        ),
        stopping,
      ]);
      ticks++;
      await onTick(lastSummary, { tick: ticks });
    } catch (error) {
      // A cooperative worker cancellation is a normal daemon shutdown. A
      // bounded-shutdown failure remains an error for the process supervisor.
      if (signal?.aborted && error.code !== "SHUTDOWN_TIMEOUT") break;
      throw error;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    }
    if (signal?.aborted || ticks >= maxTicks) break;
    await new Promise((resolve) => {
      let timer;
      const stop = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", stop);
        resolve();
      };
      timer = setTimeout(stop, intervalMs);
      signal?.addEventListener("abort", stop, { once: true });
      if (signal?.aborted) stop();
    });
  }
  return {
    ticks,
    stopped: signal?.aborted ? "signal" : "max-ticks",
    last_summary: lastSummary,
  };
}

export function tickLog(summary, tick) {
  const result = { event: "tick", tick, timestamp: new Date().toISOString() };
  // Never echo arbitrary worker output, objective text, or result evidence in daemon logs.
  if (summary && typeof summary === "object") {
    for (const key of [
      "goals_scanned",
      "task_calls",
      "review_calls",
      "completed_steps",
      "blocked_steps",
      "recovered_leases",
      "maintenance_checks",
    ]) {
      if (typeof summary[key] === "number") result[key] = summary[key];
    }
    if (Array.isArray(summary.errors)) result.errors = summary.errors.length;
  }
  return result;
}
