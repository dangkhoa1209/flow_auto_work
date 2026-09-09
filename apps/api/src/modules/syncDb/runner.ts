import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MongoClient } from "mongodb";
import { getConfig } from "../../config.js";
import { logger } from "../../logger.js";
import { AppError } from "../../utils/AppError.js";
import type { BaDbConnectionResolved } from "../../workspace/baStore.js";
import { partitionSyncCollections, SYNC_DB_SKIP_COLLECTIONS } from "./excludedCollections.js";
import { publishSyncDbEvent } from "./events.js";
import { openSyncDbLog, type SyncDbLogWriter } from "./logFile.js";
import { createProgressTracker } from "./progress.js";
import {
  assertSafeRestoreTarget,
  assertSourceUserReadonly,
} from "./safety.js";
import { resolveSyncDbSystemConfig } from "./systemConfig.js";
import { getSyncDbJob, updateSyncDbJob } from "./store.js";
import type {
  SyncDbJob,
  SyncDbLogStream,
  SyncDbProgress,
  SyncDbStatus,
  SyncDbSystemConfigResolved,
} from "./types.js";

export { assertSafeRestoreTarget } from "./safety.js";
export {
  isSkippedSyncCollection,
  partitionSyncCollections,
  SYNC_DB_SKIP_COLLECTIONS,
} from "./excludedCollections.js";

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

/** SIGTERM then SIGKILL so leftover tunnels do not hold tunnelLocalPort. */
function forceKillProcessTree(child: ChildProcess): void {
  if (child.exitCode !== null) return;
  killProcessTree(child, "SIGTERM");
  const pid = child.pid;
  if (!pid) return;
  setTimeout(() => {
    try {
      if (child.exitCode === null) {
        killProcessTree(child, "SIGKILL");
      }
    } catch {
      /* already gone */
    }
  }, 1500).unref?.();
}

/** Wait until child exits (SIGTERM → SIGKILL) so tunnelLocalPort is freed before next job. */
function forceKillProcessTreeAndWait(
  child: ChildProcess,
  timeoutMs = 4000,
): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null) {
      resolve();
      return;
    }
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      clearTimeout(hardTimer);
      resolve();
    };
    child.once("close", done);
    child.once("error", done);
    killProcessTree(child, "SIGTERM");
    const killTimer = setTimeout(() => {
      if (child.exitCode === null) killProcessTree(child, "SIGKILL");
    }, Math.min(1500, timeoutMs));
    const hardTimer = setTimeout(done, timeoutMs);
    killTimer.unref?.();
    hardTimer.unref?.();
  });
}

async function assertTunnelPortFree(port: number): Promise<void> {
  const net = await import("node:net");
  await new Promise<void>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        reject(
          new AppError(
            `SSH tunnel port ${port} already in use — leftover tunnel from a prior run? Free the port or change tunnelLocalPort in Admin Sync DB`,
            409,
            "sync_db_tunnel_port_busy",
          ),
        );
        return;
      }
      reject(err);
    });
    server.once("listening", () => {
      server.close(() => resolve());
    });
    server.listen(port, "127.0.0.1");
  });
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
    .replace(/SSHPASS=\S+/gi, "SSHPASS=***")
    .replace(/mongodb:\/\/[^/\s]+@/gi, "mongodb://***@");
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

/** Password via YAML config file (0600) — never on process argv / ps. */
function writeMongoPasswordConfig(password: string): {
  path: string;
  cleanup: () => void;
} {
  const file = path.join(
    tmpdir(),
    `flow-sync-mongo-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.yml`,
  );
  writeFileSync(file, `password: ${JSON.stringify(password)}\n`, {
    mode: 0o600,
  });
  return {
    path: file,
    cleanup: () => {
      if (existsSync(file)) {
        try {
          unlinkSync(file);
        } catch {
          /* */
        }
      }
    },
  };
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

async function withSourceMongoClient<T>(
  source: SyncDbSystemConfigResolved,
  dbName: string,
  fn: (client: MongoClient) => Promise<T>,
): Promise<T> {
  const uri = `mongodb://${encodeURIComponent(source.sourceUsername)}:${encodeURIComponent(source.sourcePassword)}@127.0.0.1:${source.tunnelLocalPort}/${encodeURIComponent(dbName)}?authSource=${encodeURIComponent(source.sourceAuthSource)}&directConnection=true`;
  const client = new MongoClient(uri, {
    serverSelectionTimeoutMS: 15_000,
  });
  try {
    await client.connect();
    return await fn(client);
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function assertSourceReadonlyViaTunnel(
  source: SyncDbSystemConfigResolved,
  dbName: string,
): Promise<void> {
  await withSourceMongoClient(source, dbName, async (client) => {
    const status = await client.db("admin").command({
      connectionStatus: 1,
      showPrivileges: true,
    });
    assertSourceUserReadonly(status, dbName);
  });
}

async function listSourceCollections(
  source: SyncDbSystemConfigResolved,
  dbName: string,
): Promise<string[]> {
  return withSourceMongoClient(source, dbName, async (client) => {
    const cols = await client.db(dbName).listCollections().toArray();
    return cols
      .map((c) => c.name)
      .filter((n) => n && !n.startsWith("system."))
      .sort();
  });
}

/** Map sshpass / OpenSSH early-exit codes to actionable admin messages. */
export function formatSshTunnelExitMessage(
  code: number | null,
  stderrHint?: string,
): string {
  const hint = (stderrHint || "").trim().replace(/\s+/g, " ").slice(0, 240);
  const lower = hint.toLowerCase();
  if (
    code === 5 ||
    lower.includes("permission denied") ||
    lower.includes("wrong password")
  ) {
    return (
      "SSH authentication failed (wrong password or user) — " +
      "fix SSH username/password in Admin → Sync DB" +
      (hint ? ` [${hint}]` : "")
    );
  }
  if (code === 6) {
    return (
      "SSH host key unknown — accept host once or pin known_hosts" +
      (hint ? ` [${hint}]` : "")
    );
  }
  if (code === 7 || lower.includes("remote host identification has changed")) {
    return (
      "SSH host key changed (possible MITM) — verify host then update known_hosts" +
      (hint ? ` [${hint}]` : "")
    );
  }
  if (code === 4) {
    return (
      "sshpass could not parse SSH prompt — check SSH user/host or use a private key" +
      (hint ? ` [${hint}]` : "")
    );
  }
  if (lower.includes("connection refused") || lower.includes("no route to host")) {
    return (
      `SSH could not reach host — check sshHost/sshPort in Admin → Sync DB` +
      (hint ? ` [${hint}]` : "")
    );
  }
  if (lower.includes("name or service not known") || lower.includes("could not resolve")) {
    return (
      "SSH hostname could not be resolved — check sshHost in Admin → Sync DB" +
      (hint ? ` [${hint}]` : "")
    );
  }
  return (
    `SSH tunnel exited early (code ${code})` + (hint ? `: ${hint}` : "")
  );
}

function openSshTunnel(
  source: SyncDbSystemConfigResolved,
): {
  child: ChildProcess;
  keyFile: string | null;
  cleanup: () => Promise<void>;
} {
  const usePassword = Boolean(source.sshPassword && !source.sshPrivateKey);
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
  // Fail fast on bad password (sshpass code 5) instead of retry prompts.
  if (usePassword) {
    args.push("-o", "NumberOfPasswordPrompts=1");
  }

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
  if (usePassword) {
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

  // No ssh -f: Node owns the child (detached process group) while dump|restore runs.
  // -f would fork-and-exit and we would lose the tunnel PID needed for reliable cleanup.
  const cleanupKey = () => {
    if (keyFile && existsSync(keyFile)) {
      try {
        unlinkSync(keyFile);
      } catch {
        /* */
      }
    }
  };

  const cleanup = async () => {
    try {
      await forceKillProcessTreeAndWait(child);
    } catch {
      forceKillProcessTree(child);
    }
    cleanupKey();
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
  let tunnelCleanup: (() => Promise<void>) | null = null;

  // Serialize + throttle progress writes. Concurrent void publishProgress caused
  // last-write-wins flicker (1/N ↔ 2/N) under interleaved dump/restore stderr.
  let progressChain: Promise<void> = Promise.resolve();
  let pendingProgress: SyncDbProgress | null = null;
  let progressTimer: ReturnType<typeof setTimeout> | null = null;

  const flushProgressNow = () => {
    const progress = pendingProgress;
    pendingProgress = null;
    if (!progress) return progressChain;
    progressChain = progressChain.then(
      async () => {
        job = await updateSyncDbJob(jobId, { progress });
        publishSyncDbEvent({ type: "progress", jobId, progress });
      },
      async () => {
        job = await updateSyncDbJob(jobId, { progress });
        publishSyncDbEvent({ type: "progress", jobId, progress });
      },
    );
    return progressChain;
  };

  const publishProgress = async (progress: SyncDbProgress, force = false) => {
    pendingProgress = progress;
    if (force) {
      if (progressTimer) {
        clearTimeout(progressTimer);
        progressTimer = null;
      }
      await flushProgressNow();
      return;
    }
    // Throttle (not debounce): publish immediately, then at most once / 200ms.
    if (!progressTimer) {
      void flushProgressNow();
      progressTimer = setTimeout(() => {
        progressTimer = null;
        if (pendingProgress) void flushProgressNow();
      }, 200);
    }
  };

  const cancel = (reason: string) => {
    cancelReason = reason;
    for (const c of children) forceKillProcessTree(c);
    void tunnelCleanup?.();
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

    await publishProgress(tracker.setPhase("connecting"), true);

    await assertTunnelPortFree(source.tunnelLocalPort);
    const tunnel = openSshTunnel(source);
    tunnelCleanup = tunnel.cleanup;
    children.push(tunnel.child);
    tunnel.child.stderr?.on("data", (chunk: Buffer) => {
      const line = chunk.toString("utf8").trim();
      if (line) emitLog(job!, log, "stderr", `ssh: ${line}`);
    });

    await waitTunnelReady(tunnel.child, source.tunnelLocalPort, 20_000);
    emitLog(job, log, "system", `SSH tunnel ready on 127.0.0.1:${source.tunnelLocalPort}`);

    await publishProgress(tracker.setPhase("listing"), true);
    emitLog(job, log, "system", "Verifying source Mongo user is read-only…");
    await assertSourceReadonlyViaTunnel(source, job.dbName);
    emitLog(job, log, "system", "Source user privilege check OK (no write on live)");

    let collections: string[] = [];
    let skippedCollections: string[] = [];
    try {
      const listed = await listSourceCollections(source, job.dbName);
      const parted = partitionSyncCollections(listed);
      collections = parted.included;
      skippedCollections = parted.skipped;
      emitLog(
        job,
        log,
        "system",
        `Listed ${listed.length} collection(s) on source` +
          (skippedCollections.length
            ? ` — skip ${skippedCollections.join(", ")} (heavy)`
            : ""),
      );
      await publishProgress(tracker.setTotal(collections.length, collections), true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      emitLog(job, log, "system", `listCollections warning: ${msg}`);
      // Still exclude known heavy names even if listCollections failed.
      skippedCollections = [...SYNC_DB_SKIP_COLLECTIONS];
    }

    if (cancelReason) throw new Error(cancelReason);

    await publishProgress(tracker.setPhase("dump"), true);

    const dumpPassCfg = writeMongoPasswordConfig(source.sourcePassword);
    const restorePassCfg = target.password
      ? writeMongoPasswordConfig(target.password)
      : null;
    const secretFilesCleanup = () => {
      dumpPassCfg.cleanup();
      restorePassCfg?.cleanup();
    };

    const dumpArgs = [
      "--host",
      "127.0.0.1",
      "--port",
      String(source.tunnelLocalPort),
      "--db",
      job.dbName,
      "--username",
      source.sourceUsername,
      "--config",
      dumpPassCfg.path,
      "--authenticationDatabase",
      source.sourceAuthSource,
      "--numParallelCollections",
      "4",
      "--archive",
      "-v",
    ];
    // Always exclude heavy collections from dump (even if listCollections missed them).
    const excludeNames = [
      ...new Set([
        ...skippedCollections,
        ...SYNC_DB_SKIP_COLLECTIONS,
      ]
        .map((n) => n.trim())
        .filter(Boolean)),
    ];
    for (const name of excludeNames) {
      dumpArgs.push("--excludeCollection", name);
    }

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
      // Acknowledged writes — {w:0} can exit OK while target silently dropped data.
      "--writeConcern={w:1}",
      "--archive",
      "-v",
    ];
    if (source.dropTarget) restoreArgs.push("--drop");
    if (target.username) {
      restoreArgs.push("--username", target.username);
      if (restorePassCfg) {
        restoreArgs.push("--config", restorePassCfg.path);
      }
      restoreArgs.push("--authenticationDatabase", "admin");
    }

    // CRITICAL: never pass source credentials to mongorestore; never put passwords on argv
    emitLog(
      job,
      log,
      "system",
      `Pipeline: mongodump (tunnel) | mongorestore (${target.host}:${target.port}) writeConcern=w:1` +
        (excludeNames.length
          ? `; excludeCollection=${excludeNames.join(",")}`
          : ""),
    );

    try {
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
      // Node pipe + wait BOTH exits (pipefail equivalent — bash | alone is not used).
      dump.stdout.pipe(restore.stdin, { end: true });
      // If one side dies, stop the other so we do not hang or keep writing a bad archive.
      dump.stdout.on("error", () => forceKillProcessTree(restore));
      restore.stdin.on("error", () => forceKillProcessTree(dump));

      const onProgress = (line: string, phaseHint?: "dump" | "restore") => {
        // Stream hint classifies progress-bar lines (no dump/restore keyword).
        const next = tracker.applyLine(line, phaseHint);
        void publishProgress(next, false);
      };

      const dumpErr = createLineSplitter((line) => {
        emitLog(job!, log, "stderr", line);
        onProgress(line, "dump");
      });
      const restoreErr = createLineSplitter((line) => {
        emitLog(job!, log, "stderr", line);
        onProgress(line, "restore");
      });
      const restoreOut = createLineSplitter((line) => {
        emitLog(job!, log, "stdout", line);
        onProgress(line, "restore");
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
        dump.on("close", (code, signal) => {
          if (code !== 0 || signal) forceKillProcessTree(restore);
          resolve(signal && code === null ? 1 : code);
        });
        dump.on("error", () => {
          forceKillProcessTree(restore);
          resolve(1);
        });
      });
      const restoreExit = new Promise<number | null>((resolve) => {
        restore.on("close", (code, signal) => {
          if (code !== 0 || signal) forceKillProcessTree(dump);
          resolve(signal && code === null ? 1 : code);
        });
        restore.on("error", () => {
          forceKillProcessTree(dump);
          resolve(1);
        });
      });

      const [dumpCode, restoreCode] = await Promise.all([dumpExit, restoreExit]);
      clearTimeout(timer);
      dumpErr.flush();
      restoreErr.flush();
      restoreOut.flush();

      if (tunnelCleanup) {
        await tunnelCleanup();
        tunnelCleanup = null;
      }

      const durationMs = Date.now() - started;
      let status: SyncDbStatus = "success";
      let errorMessage: string | undefined;
      let exitCode: number | null = restoreCode ?? dumpCode;

      // Fail if either side of the pipe fails (or exits null / signal) — never trust restore alone.
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
        // Prefer tracked counts; only fill remaining if parse missed a few lines.
        const tracked = (finalProgress.dumpDone ?? 0) + (finalProgress.restoreDone ?? 0);
        finalProgress.done = Math.max(tracked, finalProgress.total);
        finalProgress.dumpDone = finalProgress.collections ?? finalProgress.dumpDone;
        finalProgress.restoreDone =
          finalProgress.collections ?? finalProgress.restoreDone;
        finalProgress.current = [];
      }
      await publishProgress(finalProgress, true);
      await progressChain;

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
    } finally {
      secretFilesCleanup();
    }
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
    if (tunnelCleanup) {
      await tunnelCleanup().catch(() => undefined);
      tunnelCleanup = null;
    }
    active.delete(jobId);
    await log.close();
  }
}
