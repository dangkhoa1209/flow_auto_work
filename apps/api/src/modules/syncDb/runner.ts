import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MongoClient } from "mongodb";
import { getConfig } from "../../config.js";
import { logger } from "../../logger.js";
import { AppError } from "../../utils/AppError.js";
import type { BaDbConnectionResolved } from "../../workspace/baStore.js";
import { publishSyncDbEvent } from "./events.js";
import { openSyncDbLog, type SyncDbLogWriter } from "./logFile.js";
import { createProgressTracker } from "./progress.js";
import { resolveSyncDbSystemConfig } from "./systemConfig.js";
import { getSyncDbJob, updateSyncDbJob } from "./store.js";
import type {
  SyncDbJob,
  SyncDbLogStream,
  SyncDbProgress,
  SyncDbStatus,
  SyncDbSystemConfigResolved,
} from "./types.js";

export type SyncDbRunResult = {
  job: SyncDbJob;
  status: SyncDbStatus;
  exitCode: number | null;
  durationMs: number;
};

type ActiveRun = {
  jobId: string;
  children: ChildProcess[];
  cancel: (reason: string) => void;
};

const active = new Map<string, ActiveRun>();

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

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

function emitLog(
  job: SyncDbJob,
  log: SyncDbLogWriter,
  stream: SyncDbLogStream,
  text: string,
) {
  // Never leak secrets into logs
  const scrubbed = text
    .replace(/--password=\S+/gi, "--password=***")
    .replace(/SSHPASS=\S+/gi, "SSHPASS=***");
  const at = new Date().toISOString();
  log.write(stream, scrubbed, at);
  publishSyncDbEvent({
    type: "log",
    jobId: job.id,
    at,
    stream,
    text: scrubbed,
  });
}

/**
 * Hard safety: restore ONLY to project Connect DB target.
 * Never allow restore host to be the SSH/live server host.
 * Prefer loopback / private targets.
 */
export function assertSafeRestoreTarget(
  target: BaDbConnectionResolved,
  source: SyncDbSystemConfigResolved,
): void {
  const th = target.host.trim().toLowerCase();
  const ssh = source.sshHost.trim().toLowerCase();
  if (!th) {
    throw new AppError("Target DB host missing", 400, "sync_db_bad_target");
  }
  if (th === ssh) {
    throw new AppError(
      "Refusing sync: target host matches SSH/live server — restore to live is forbidden",
      403,
      "sync_db_live_forbidden",
    );
  }
  // Source dump always via local tunnel — never restore to tunnel port as if it were target
  if (
    LOOPBACK.has(th) &&
    target.port === source.tunnelLocalPort
  ) {
    throw new AppError(
      "Refusing sync: target port equals tunnel port (would hit live via tunnel)",
      403,
      "sync_db_live_forbidden",
    );
  }
}

export function isSyncDbRunning(jobId: string): boolean {
  return active.has(jobId);
}

export async function cancelRunningSyncDb(
  jobId: string,
  reason: string,
): Promise<boolean> {
  const run = active.get(jobId);
  if (!run) return false;
  run.cancel(reason);
  return true;
}

async function listSourceCollections(
  source: SyncDbSystemConfigResolved,
  dbName: string,
): Promise<string[]> {
  const uri = `mongodb://${encodeURIComponent(source.sourceUsername)}:${encodeURIComponent(source.sourcePassword)}@127.0.0.1:${source.tunnelLocalPort}/${encodeURIComponent(dbName)}?authSource=${encodeURIComponent(source.sourceAuthSource)}&directConnection=true`;
  const client = new MongoClient(uri, {
    serverSelectionTimeoutMS: 15_000,
  });
  try {
    await client.connect();
    const cols = await client.db(dbName).listCollections().toArray();
    return cols
      .map((c) => c.name)
      .filter((n) => n && !n.startsWith("system."))
      .sort();
  } finally {
    await client.close().catch(() => undefined);
  }
}

function openSshTunnel(
  source: SyncDbSystemConfigResolved,
): { child: ChildProcess; keyFile: string | null; cleanup: () => void } {
  const args = [
    "-L",
    `${source.tunnelLocalPort}:${source.remoteMongoHost}:${source.remoteMongoPort}`,
    `${source.sshUsername}@${source.sshHost}`,
    "-p",
    String(source.sshPort),
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    "ServerAliveInterval=30",
    "-o",
    "ServerAliveCountMax=3",
    "-o",
    "TCPKeepAlive=yes",
    "-N",
  ];

  let keyFile: string | null = null;
  const env = { ...process.env };
  delete env.SSHPASS;

  if (source.sshPrivateKey) {
    keyFile = path.join(
      tmpdir(),
      `flow-sync-ssh-${process.pid}-${Date.now()}.pem`,
    );
    writeFileSync(keyFile, source.sshPrivateKey, { mode: 0o600 });
    args.unshift("-i", keyFile);
  }

  let child: ChildProcess;
  if (source.sshPassword && !source.sshPrivateKey) {
    env.SSHPASS = source.sshPassword;
    child = spawn("sshpass", ["-e", "ssh", ...args], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
  } else {
    child = spawn("ssh", args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
  }

  const cleanup = () => {
    try {
      killProcessTree(child, "SIGTERM");
    } catch {
      /* */
    }
    if (keyFile && existsSync(keyFile)) {
      try {
        unlinkSync(keyFile);
      } catch {
        /* */
      }
    }
  };

  return { child, keyFile, cleanup };
}

function waitTunnelReady(
  child: ChildProcess,
  port: number,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    let settled = false;
    const fail = (msg: string) => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      reject(new Error(msg));
    };
    const ok = () => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      resolve();
    };

    child.once("error", (err) => fail(`SSH tunnel spawn failed: ${err.message}`));
    child.once("exit", (code) => {
      if (!settled) fail(`SSH tunnel exited early (code ${code})`);
    });

    const timer = setInterval(() => {
      if (Date.now() - started > timeoutMs) {
        fail("SSH tunnel timeout — port not listening");
        return;
      }
      // Probe with a quick TCP connect via bash /dev/tcp or node net
      import("node:net")
        .then((net) => {
          const s = net.connect({ host: "127.0.0.1", port }, () => {
            s.end();
            ok();
          });
          s.on("error", () => {
            s.destroy();
          });
        })
        .catch(() => undefined);
    }, 400);
  });
}

export async function runSyncDbJob(
  jobId: string,
  target: BaDbConnectionResolved,
): Promise<SyncDbRunResult> {
  const started = Date.now();
  let job = await getSyncDbJob(jobId);
  if (!job) {
    throw new AppError("Sync DB job not found", 404, "sync_db_not_found");
  }

  const log = await openSyncDbLog(jobId);
  const tracker = createProgressTracker(job.dbName);
  let cancelReason: string | null = null;
  const children: ChildProcess[] = [];
  let tunnelCleanup: (() => void) | null = null;

  const publishProgress = async (progress: SyncDbProgress) => {
    job = await updateSyncDbJob(jobId, { progress });
    publishSyncDbEvent({ type: "progress", jobId, progress });
    publishSyncDbEvent({ type: "job", job });
  };

  const cancel = (reason: string) => {
    cancelReason = reason;
    for (const c of children) killProcessTree(c, "SIGTERM");
    tunnelCleanup?.();
  };

  active.set(jobId, { jobId, children, cancel });

  try {
    const source = await resolveSyncDbSystemConfig();
    assertSafeRestoreTarget(target, source);

    if (target.dialect !== "mongodb") {
      throw new AppError(
        "Sync Database only supports MongoDB projects",
        400,
        "sync_db_not_mongo",
      );
    }

    emitLog(job, log, "system", `Sync DB '${job.dbName}' → ${target.host}:${target.port}`);
    emitLog(
      job,
      log,
      "system",
      "Safety: dump read-only from live via SSH tunnel; restore only to project Connect DB target",
    );

    await publishProgress(tracker.setPhase("connecting"));

    const tunnel = openSshTunnel(source);
    tunnelCleanup = tunnel.cleanup;
    children.push(tunnel.child);
    tunnel.child.stderr?.on("data", (chunk: Buffer) => {
      const line = chunk.toString("utf8").trim();
      if (line) emitLog(job!, log, "stderr", `ssh: ${line}`);
    });

    await waitTunnelReady(tunnel.child, source.tunnelLocalPort, 20_000);
    emitLog(job, log, "system", `SSH tunnel ready on 127.0.0.1:${source.tunnelLocalPort}`);

    await publishProgress(tracker.setPhase("listing"));
    let collections: string[] = [];
    try {
      collections = await listSourceCollections(source, job.dbName);
      emitLog(
        job,
        log,
        "system",
        `Listed ${collections.length} collection(s) on source`,
      );
      await publishProgress(tracker.setTotal(collections.length, collections));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      emitLog(job, log, "system", `listCollections warning: ${msg}`);
    }

    if (cancelReason) throw new Error(cancelReason);

    await publishProgress(tracker.setPhase("dump"));

    const dumpArgs = [
      "--host",
      "127.0.0.1",
      "--port",
      String(source.tunnelLocalPort),
      "--db",
      job.dbName,
      "--username",
      source.sourceUsername,
      `--password=${source.sourcePassword}`,
      "--authenticationDatabase",
      source.sourceAuthSource,
      "--numParallelCollections",
      "4",
      "--archive",
      "-v",
    ];

    const restoreArgs = [
      "--host",
      target.host,
      "--port",
      String(target.port),
      "--nsInclude",
      `${job.dbName}.*`,
      "--numParallelCollections",
      "4",
      "--bypassDocumentValidation",
      "--writeConcern={w:0}",
      "--archive",
      "-v",
    ];
    if (source.dropTarget) restoreArgs.push("--drop");
    if (target.username) {
      restoreArgs.push("--username", target.username);
      if (target.password) {
        restoreArgs.push(`--password=${target.password}`);
      }
      restoreArgs.push("--authenticationDatabase", "admin");
    }

    // CRITICAL: never pass source credentials to mongorestore
    emitLog(
      job,
      log,
      "system",
      `Pipeline: mongodump (tunnel) | mongorestore (${target.host}:${target.port})`,
    );

    const dump = spawn("mongodump", dumpArgs, {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      env: { ...process.env },
    });
    const restore = spawn("mongorestore", restoreArgs, {
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
      env: { ...process.env },
    });
    children.push(dump, restore);

    if (!dump.stdout || !restore.stdin) {
      throw new Error("Failed to pipe mongodump → mongorestore");
    }
    dump.stdout.pipe(restore.stdin);

    const onProgress = async (line: string) => {
      const next = tracker.applyLine(line);
      await publishProgress(next);
    };

    const dumpErr = createLineSplitter((line) => {
      emitLog(job!, log, "stderr", line);
      void onProgress(line);
    });
    const restoreErr = createLineSplitter((line) => {
      emitLog(job!, log, "stderr", line);
      void onProgress(line);
    });
    const restoreOut = createLineSplitter((line) => {
      emitLog(job!, log, "stdout", line);
      void onProgress(line);
    });

    dump.stderr?.on("data", (c: Buffer) => dumpErr.push(c));
    restore.stderr?.on("data", (c: Buffer) => restoreErr.push(c));
    restore.stdout?.on("data", (c: Buffer) => restoreOut.push(c));

    const timeoutMs =
      (source.timeoutSec || getConfig().SYNC_DB_TIMEOUT_SEC || 3600) * 1000;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      cancel("Sync timed out");
    }, timeoutMs);

    const dumpExit = new Promise<number | null>((resolve) => {
      dump.on("close", (code) => resolve(code));
      dump.on("error", () => resolve(1));
    });
    const restoreExit = new Promise<number | null>((resolve) => {
      restore.on("close", (code) => resolve(code));
      restore.on("error", () => resolve(1));
    });

    const [dumpCode, restoreCode] = await Promise.all([dumpExit, restoreExit]);
    clearTimeout(timer);
    dumpErr.flush();
    restoreErr.flush();
    restoreOut.flush();

    tunnelCleanup?.();
    tunnelCleanup = null;

    const durationMs = Date.now() - started;
    let status: SyncDbStatus = "success";
    let errorMessage: string | undefined;
    let exitCode: number | null = restoreCode ?? dumpCode;

    if (cancelReason) {
      status = timedOut ? "timeout" : "cancelled";
      errorMessage = cancelReason;
      exitCode = null;
    } else if (dumpCode !== 0) {
      status = "failed";
      errorMessage = `mongodump failed (exit ${dumpCode})`;
      exitCode = dumpCode;
    } else if (restoreCode !== 0) {
      status = "failed";
      errorMessage = `mongorestore failed (exit ${restoreCode})`;
      exitCode = restoreCode;
    }

    const finalProgress = tracker.setPhase(
      status === "success" ? "done" : "failed",
    );
    if (status === "success" && finalProgress.total > 0) {
      finalProgress.done = finalProgress.total;
      finalProgress.current = [];
    }

    job = await updateSyncDbJob(jobId, {
      status,
      finishedAt: new Date().toISOString(),
      durationMs,
      exitCode,
      errorMessage,
      progress: finalProgress,
      cancelRequested: Boolean(cancelReason),
    });

    emitLog(
      job,
      log,
      "system",
      status === "success"
        ? `Sync OK in ${(durationMs / 1000).toFixed(1)}s`
        : `Sync ${status}: ${errorMessage || status}`,
    );
    publishSyncDbEvent({ type: "job", job });
    publishSyncDbEvent({ type: "done", jobId, job });
    publishSyncDbEvent({ type: "progress", jobId, progress: finalProgress });

    return { job, status, exitCode, durationMs };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("Sync DB runner failed", { jobId, err: msg });
    const durationMs = Date.now() - started;
    const progress = tracker.setPhase("failed");
    emitLog(job, log, "system", `error: ${msg}`);
    job = await updateSyncDbJob(jobId, {
      status: cancelReason
        ? String(cancelReason).toLowerCase().includes("timeout")
          ? "timeout"
          : "cancelled"
        : "failed",
      finishedAt: new Date().toISOString(),
      durationMs,
      exitCode: null,
      errorMessage: cancelReason || msg,
      progress,
    });
    publishSyncDbEvent({ type: "job", job });
    publishSyncDbEvent({ type: "done", jobId, job });
    return { job, status: job.status, exitCode: null, durationMs };
  } finally {
    tunnelCleanup?.();
    active.delete(jobId);
    await log.close();
  }
}
