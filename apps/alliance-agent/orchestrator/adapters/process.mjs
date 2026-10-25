import { spawn } from "node:child_process";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { WorkerError, preflight } from "./protocol.mjs";

export function findBinary(binary, env = process.env) {
  if (typeof binary !== "string" || !binary || binary.length > 4000)
    return null;
  const paths =
    isAbsolute(binary) || binary.includes("/") || binary.includes("\\")
      ? [resolve(binary)]
      : (env.PATH ?? "")
          .split(delimiter)
          .map((directory) => join(directory, binary));
  for (const path of paths) {
    try {
      accessSync(path, constants.X_OK);
      if (statSync(path).isFile()) return realpathSync(path);
    } catch {
      /* unavailable */
    }
  }
  return null;
}

export function workdirPath(path) {
  if (typeof path !== "string" || !isAbsolute(path))
    throw preflight("WORKDIR_REQUIRED", "Configure an absolute worker workdir");
  try {
    const real = realpathSync(path);
    if (statSync(real).isDirectory()) return real;
  } catch {
    /* below */
  }
  throw preflight(
    "WORKDIR_MISSING",
    "Configured worker workdir is unavailable",
  );
}

export function runProcess(
  binary,
  args,
  {
    input = "",
    cwd,
    env = process.env,
    signal,
    timeoutMs = 120_000,
    maxOutputBytes = 2_000_000,
  } = {},
) {
  if (signal?.aborted)
    return Promise.reject(
      preflight("ABORTED", "Worker was cancelled before start"),
    );
  if (
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0 ||
    !Number.isSafeInteger(maxOutputBytes) ||
    maxOutputBytes < 100
  ) {
    return Promise.reject(
      preflight(
        "INVALID_CONFIG",
        "Worker timeout and output limit must be positive",
      ),
    );
  }
  return new Promise((resolvePromise, reject) => {
    let child;
    let stopError;
    let killTimer;
    let bytes = 0;
    const stdout = [];
    const stderr = [];
    const detached = process.platform !== "win32";
    const kill = (sig) => {
      try {
        if (child?.pid)
          detached ? process.kill(-child.pid, sig) : child.kill(sig);
      } catch {
        /* process already exited */
      }
    };
    const stop = (error) => {
      if (stopError) return;
      stopError = error;
      kill("SIGTERM");
      killTimer = setTimeout(() => kill("SIGKILL"), 500);
      killTimer.unref();
    };
    const abort = () =>
      stop(new WorkerError("ABORTED", "Worker was cancelled"));
    const timer = setTimeout(
      () =>
        stop(
          new WorkerError(
            "TIMEOUT",
            "Worker exceeded its configured deadline",
            { retryable: true },
          ),
        ),
      timeoutMs,
    );
    timer.unref();
    const cleanup = () => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal?.removeEventListener("abort", abort);
    };
    try {
      child = spawn(binary, args, {
        cwd,
        env,
        shell: false,
        detached,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const collect = (target) => (chunk) => {
        bytes += chunk.length;
        if (bytes > maxOutputBytes)
          stop(
            new WorkerError(
              "OUTPUT_LIMIT",
              "Worker exceeded its configured output limit",
            ),
          );
        else target.push(chunk);
      };
      child.stdout.on("data", collect(stdout));
      child.stderr.on("data", collect(stderr));
      child.stdin.on("error", () => {
        /* EPIPE is represented by process exit. */
      });
      child.on("error", (error) => {
        cleanup();
        reject(
          preflight(
            error.code === "ENOENT" ? "BINARY_MISSING" : "PROCESS_ERROR",
            "Unable to start the configured worker process",
          ),
        );
      });
      child.on("close", (code, exitSignal) => {
        cleanup();
        if (stopError) reject(stopError);
        else
          resolvePromise({
            code,
            signal: exitSignal,
            stdout: Buffer.concat(stdout).toString("utf8"),
            stderr: Buffer.concat(stderr).toString("utf8"),
          });
      });
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      child.stdin.end(input);
    } catch {
      cleanup();
      reject(
        preflight(
          "PROCESS_ERROR",
          "Unable to start the configured worker process",
        ),
      );
    }
  });
}
