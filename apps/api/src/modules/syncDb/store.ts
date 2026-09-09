import { type Collection } from "mongodb";
import { withActive } from "../../models/base.js";
import { SyncDbJobModel } from "../../models/syncDb.js";
import { AppError } from "../../utils/AppError.js";
import { logPathForSyncDb } from "./logFile.js";
import { isDuplicateKeyError } from "./safety.js";
import {
  emptyProgress,
  isTerminalSyncDbStatus,
  newSyncDbId,
  type SyncDbJob,
  type SyncDbProgress,
  type SyncDbStatus,
} from "./types.js";

export async function ensureSyncDbIndexes(): Promise<void> {
  await SyncDbJobModel.ensureIndexes();
}

async function col(): Promise<Collection<SyncDbJob>> {
  await ensureSyncDbIndexes();
  return (await SyncDbJobModel.col()) as Collection<SyncDbJob>;
}

export async function insertSyncDbJob(job: SyncDbJob): Promise<SyncDbJob> {
  try {
    await SyncDbJobModel.insert({ ...job, deleted: false, deletedAt: null });
  } catch (err) {
    if (isDuplicateKeyError(err)) {
      throw new AppError(
        `Sync already queued/running for this project (${job.dbName})`,
        409,
        "sync_db_project_busy",
      );
    }
    throw err;
  }
  return job;
}

export async function getSyncDbJob(id: string): Promise<SyncDbJob | null> {
  const jobId = id.trim();
  if (!jobId) return null;
  return (await col()).findOne(withActive({ id: jobId }));
}

export async function requireSyncDbJob(id: string): Promise<SyncDbJob> {
  const job = await getSyncDbJob(id);
  if (!job) throw new AppError("Sync DB job not found", 404, "sync_db_not_found");
  return job;
}

/** Require job and that it belongs to projectId (no cross-project peek/cancel). */
export async function requireSyncDbJobForProject(
  id: string,
  projectId: string,
): Promise<SyncDbJob> {
  const job = await requireSyncDbJob(id);
  const pid = projectId.trim();
  if (!pid || job.projectId !== pid) {
    throw new AppError(
      "Sync DB job not found for this project",
      404,
      "sync_db_not_found",
    );
  }
  return job;
}

export async function updateSyncDbJob(
  id: string,
  patch: Partial<Omit<SyncDbJob, "id">>,
): Promise<SyncDbJob> {
  const updatedAt = new Date().toISOString();
  const res = await (
    await col()
  ).findOneAndUpdate(
    withActive({ id }),
    { $set: { ...patch, updatedAt } },
    { returnDocument: "after" },
  );
  if (!res) {
    throw new AppError("Sync DB job not found", 404, "sync_db_not_found");
  }
  return res;
}

export async function listSyncDbJobs(opts?: {
  limit?: number;
  offset?: number;
  status?: SyncDbStatus;
  projectId?: string;
}): Promise<SyncDbJob[]> {
  const limit = Math.min(200, Math.max(1, opts?.limit ?? 50));
  const offset = Math.max(0, opts?.offset ?? 0);
  const filter: Record<string, unknown> = {};
  if (opts?.status) filter.status = opts.status;
  if (opts?.projectId) filter.projectId = opts.projectId;
  return (await col())
    .find(withActive(filter))
    .sort({ createdAt: -1 })
    .skip(offset)
    .limit(limit)
    .toArray();
}

export async function countSyncDbJobs(opts?: {
  status?: SyncDbStatus;
  projectId?: string;
}): Promise<number> {
  const filter: Record<string, unknown> = {};
  if (opts?.status) filter.status = opts.status;
  if (opts?.projectId) filter.projectId = opts.projectId;
  return (await col()).countDocuments(withActive(filter));
}

export async function listQueuedSyncDbJobs(): Promise<SyncDbJob[]> {
  return (await col())
    .find(withActive({ status: "queued" }))
    .sort({ queuedAt: 1 })
    .toArray();
}

export async function listRunningSyncDbJobs(): Promise<SyncDbJob[]> {
  return (await col()).find(withActive({ status: "running" })).toArray();
}

export async function findActiveJobForProject(
  projectId: string,
): Promise<SyncDbJob | null> {
  return (await col()).findOne(
    withActive({
      projectId,
      status: { $in: ["queued", "running"] },
    }),
  );
}

/**
 * Atomically claim a queued job. Unique partial index on status=running
 * is the global mutex (E11000 → another runner won the race).
 */
export async function tryClaimSyncDbJobForRun(
  jobId: string,
): Promise<SyncDbJob | null> {
  const c = await col();
  const now = new Date().toISOString();
  try {
    const res = await c.findOneAndUpdate(
      withActive({ id: jobId, status: "queued" }),
      { $set: { status: "running", startedAt: now, updatedAt: now } },
      { returnDocument: "after" },
    );
    return res ?? null;
  } catch (err) {
    if (isDuplicateKeyError(err)) return null;
    throw err;
  }
}

export function createQueuedSyncDbJob(opts: {
  projectId: string;
  projectName: string;
  dbName: string;
  triggeredBy: string;
  targetHost: string;
  targetPort: number;
}): SyncDbJob {
  const now = new Date().toISOString();
  const id = newSyncDbId();
  const progress = emptyProgress(opts.dbName);
  return {
    id,
    projectId: opts.projectId,
    projectName: opts.projectName,
    dbName: opts.dbName,
    status: "queued",
    triggeredBy: opts.triggeredBy,
    queuedAt: now,
    logFile: logPathForSyncDb(id),
    progress,
    targetHost: opts.targetHost,
    targetPort: opts.targetPort,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Boot recovery: jobs left `running` when Node died → `queued` so the pump
 * can claim and re-run (dump/restore restarts from scratch). Keeps queuedAt
 * for FIFO order. Awaiting user cancel is not applicable here.
 */
export async function requeueInterruptedSyncDbJobs(): Promise<number> {
  const running = await listRunningSyncDbJobs();
  let n = 0;
  const now = new Date().toISOString();
  const c = await col();
  for (const job of running) {
    if (isTerminalSyncDbStatus(job.status)) continue;
    const res = await c.findOneAndUpdate(
      withActive({ id: job.id, status: "running" }),
      {
        $set: {
          status: "queued",
          progress: emptyProgress(job.dbName),
          updatedAt: now,
        },
        $unset: {
          startedAt: "",
          finishedAt: "",
          durationMs: "",
          exitCode: "",
          errorMessage: "",
          cancelRequested: "",
        },
      },
      { returnDocument: "after" },
    );
    if (!res) continue;
    try {
      const { openSyncDbLog } = await import("./logFile.js");
      const log = await openSyncDbLog(job.id);
      log.write(
        "system",
        "Server restarted — this sync was re-queued automatically.",
      );
      await log.close();
    } catch {
      /* best-effort note */
    }
    n += 1;
  }
  return n;
}

export async function patchSyncDbProgress(
  jobId: string,
  progress: SyncDbProgress,
): Promise<SyncDbJob> {
  return updateSyncDbJob(jobId, { progress });
}
