import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { getConfig } from "../../config.js";
import { logger } from "../../logger.js";
import { AppError } from "../../utils/AppError.js";
import { requireWhitelistedScript } from "./catalog.js";
import { publishBuildEvent } from "./events.js";
import { openBuildLog, type BuildLogWriter } from "./logFile.js";
import { getBuildJob, updateBuildJob } from "./store.js";
import type { BuildJob, BuildLogStream, BuildStatus } from "./types.js";

export type BuildRunResult = {
  job: BuildJob;
  status: BuildStatus;
  exitCode: number | null;
  durationMs: number;
};

type ActiveRun = {
  child: ChildProcess;
  jobId: string;
  cancel: (reason: string) => void;
  writeStdin: (chunk: string, secret?: boolean) => void;
};

const active = new Map<string, ActiveRun>();
const MAX_STDIN_BYTES = 4096;

function emitLog(
  job: BuildJob,
  log: BuildLogWriter,
  stream: BuildLogStream,
  text: string,
) {
  const at = new Date().toISOString();
  log.write(stream, text, at);
  publishBuildEvent({
    type: "log",
    buildId: job.id,
    at,
    stream,
    text,
  });
}

function createLineSplitter(onLine: (line: string) => void) {
  let buf = "";
  return {
    push(chunk: Buffer | string) {
      buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const parts = buf.split(/\r?\n/);
      buf = parts.pop() ?? "";
      for (const part of parts) onLine(part);
    },
    flush() {
      if (!buf) return;
      onLine(buf);
      buf = "";
    },
  };
}

function killProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (!pid) return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(pid), "/t", "/f"], {
        stdio: "ignore",
        windowsHide: true,
      });
      return;
    }
    try {
      process.kill(-pid, signal);
    } catch {
      child.kill(signal);
    }
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  }
}

export function isBuildRunning(jobId: string): boolean {
  return active.has(jobId);
}

export async function cancelRunningBuild(
  jobId: string,
  reason: string,
): Promise<boolean> {
  const run = active.get(jobId);
  if (!run) return false;
  run.cancel(reason);
  return true;
}

/** Write a line to the running job's stdin (appends newline if missing). */
export function writeBuildStdin(
  jobId: string,
  data: string,
  secret = false,
): void {
  if (data.length > MAX_STDIN_BYTES) {
    throw new AppError(
      `stdin too long (max ${MAX_STDIN_BYTES} characters)`,
      400,
      "stdin_too_long",
    );
  }
  const run = active.get(jobId);
  if (!run) {
    throw new AppError(
      "No running build to write stdin",
      409,
      "build_not_running",
    );
  }
  run.writeStdin(data, secret);
}

/**
 * Spawn a whitelisted script with `shell: true` + `cwd: workingDir`.
 * Command is always re-read from the catalog — never from client input.
 */
export async function runBuildJob(jobId: string): Promise<BuildRunResult> {
  const loaded = await getBuildJob(jobId);
  if (!loaded) {
    throw new AppError("Build job not found", 404, "build_not_found");
  }

  const script = await requireWhitelistedScript(loaded.scriptId);
  const cfg = getConfig();
  const timeoutSec = script.timeoutSec ?? cfg.BUILD_TIMEOUT_SEC;
  const killGraceMs = Math.max(500, cfg.BUILD_KILL_GRACE_MS);

  if (!existsSync(script.workingDir)) {
    const now = new Date().toISOString();
    const job = await updateBuildJob(jobId, {
      status: "failed",
      startedAt: now,
      finishedAt: now,
      durationMs: 0,
      exitCode: null,
      errorMessage: `workingDir does not exist: ${script.workingDir}`,
    });
    publishBuildEvent({ type: "job", job });
    return { job, status: "failed", exitCode: null, durationMs: 0 };
  }
  if (!statSync(script.workingDir).isDirectory()) {
    const now = new Date().toISOString();
    const job = await updateBuildJob(jobId, {
      status: "failed",
      startedAt: now,
      finishedAt: now,
      durationMs: 0,
      exitCode: null,
      errorMessage: `workingDir is not a directory: ${script.workingDir}`,
    });
    publishBuildEvent({ type: "job", job });
    return { job, status: "failed", exitCode: null, durationMs: 0 };
  }

  const startedAt = new Date();
  const startedIso = startedAt.toISOString();
  let job = await updateBuildJob(jobId, {
    status: "running",
    startedAt: startedIso,
    command: script.command,
    workingDir: script.workingDir,
    scriptLabel: script.label,
    errorMessage: "",
    cancelRequested: false,
  });
  publishBuildEvent({ type: "job", job });

  const log = await openBuildLog(job.id);
  emitLog(job, log, "system", `started command: ${script.command}`);
  emitLog(job, log, "system", `cwd: ${script.workingDir}`);

  return new Promise<BuildRunResult>((resolve) => {
    let settled = false;
    let cancelReason: string | null = null;
    let timedOut = false;
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
    let killTimer: ReturnType<typeof setTimeout> | null = null;

    const stdoutSplit = createLineSplitter((line) =>
      emitLog(job, log, "stdout", line),
    );
    const stderrSplit = createLineSplitter((line) =>
      emitLog(job, log, "stderr", line),
    );

    const finish = async (
      status: BuildStatus,
      exitCode: number | null,
      errorMessage?: string,
    ) => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      active.delete(jobId);
      stdoutSplit.flush();
      stderrSplit.flush();

      const finishedAt = new Date();
      const durationMs = Math.max(0, finishedAt.getTime() - startedAt.getTime());
      emitLog(
        job,
        log,
        "system",
        `finished status=${status} exitCode=${exitCode ?? "n/a"} durationMs=${durationMs}`,
      );
      await log.close().catch(() => undefined);

      try {
        job = await updateBuildJob(jobId, {
          status,
          finishedAt: finishedAt.toISOString(),
          durationMs,
          exitCode,
          errorMessage,
        });
      } catch (err) {
        logger.error("Failed to persist build result", {
          jobId,
          err: String(err),
        });
      }
      publishBuildEvent({ type: "job", job });
      publishBuildEvent({ type: "done", buildId: jobId, job });
      resolve({ job, status, exitCode, durationMs });
    };

    let child: ChildProcess;
    try {
      child = spawn(script.command, {
        shell: true,
        cwd: script.workingDir,
        env: {
          ...process.env,
          CI: "1",
          FLOW_BUILD_JOB_ID: job.id,
          FLOW_BUILD_SCRIPT_ID: script.id,
          FLOW_BUILD_TRIGGERED_BY: job.triggeredBy,
        },
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      void finish("failed", null, `spawn failed: ${msg}`);
      return;
    }

    const writeStdin = (chunk: string, secret?: boolean) => {
      if (!child.stdin || child.stdin.destroyed || child.killed) {
        throw new AppError(
          "Build process is not accepting stdin",
          409,
          "build_stdin_closed",
        );
      }
      const payload = chunk.endsWith("\n") ? chunk : `${chunk}\n`;
      child.stdin.write(payload);
      emitLog(
        job,
        log,
        "system",
        secret ? "[stdin] <redacted>" : `[stdin] ${chunk.replace(/\n+$/, "")}`,
      );
    };

    const requestCancel = (reason: string) => {
      if (settled) return;
      cancelReason = reason;
      void updateBuildJob(jobId, { cancelRequested: true }).catch(() => undefined);
      emitLog(job, log, "system", `cancel requested: ${reason}`);
      killProcessTree(child, "SIGTERM");
      if (killTimer) return;
      killTimer = setTimeout(() => {
        if (settled) return;
        emitLog(job, log, "system", "SIGTERM ignored — sending SIGKILL");
        killProcessTree(child, "SIGKILL");
      }, killGraceMs);
      killTimer.unref?.();
    };

    active.set(jobId, { child, jobId, cancel: requestCancel, writeStdin });

    child.stdout?.on("data", (chunk) => stdoutSplit.push(chunk));
    child.stderr?.on("data", (chunk) => stderrSplit.push(chunk));

    child.on("error", (err) => {
      logger.error("Build process error", { jobId, err: err.message });
      void finish("failed", null, `process error: ${err.message}`);
    });

    timeoutTimer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      emitLog(
        job,
        log,
        "system",
        `timeout after ${timeoutSec}s — sending SIGTERM`,
      );
      requestCancel(`Timed out after ${timeoutSec}s`);
    }, timeoutSec * 1000);
    timeoutTimer.unref?.();

    child.on("close", (code, signal) => {
      const exitCode = typeof code === "number" ? code : null;
      if (timedOut) {
        void finish(
          "timeout",
          exitCode,
          `Timed out after ${timeoutSec}s` +
            (signal ? ` (signal ${signal})` : ""),
        );
        return;
      }
      if (cancelReason) {
        void finish(
          "cancelled",
          exitCode,
          cancelReason + (signal ? ` (signal ${signal})` : ""),
        );
        return;
      }
      if (exitCode === 0) {
        void finish("success", 0);
        return;
      }
      void finish(
        "failed",
        exitCode,
        exitCode == null
          ? `Process ended without exit code (signal ${signal ?? "unknown"})`
          : `Exit code ${exitCode}`,
      );
    });
  });
}
