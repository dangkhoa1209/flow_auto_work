import { type Collection } from "mongodb";
import { withActive } from "../../models/base.js";
import { SyncDbJobModel } from "../../models/syncDb.js";
import { AppError } from "../../utils/AppError.js";
import { logPathForSyncDb } from "./logFile.js";
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
  await SyncDbJobModel.insert({ ...job, deleted: false, deletedAt: null });
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
 * Atomically start the next queued job only if nothing else is running
 * (Mongo is the global mutex — concurrency 1 system-wide).
 */
export async function tryClaimSyncDbJobForRun(
  jobId: string,
): Promise<SyncDbJob | null> {
  const c = await col();
  const otherRunning = await c.findOne(withActive({ status: "running" }));
  if (otherRunning) return null;

  const now = new Date().toISOString();
  const res = await c.findOneAndUpdate(
    withActive({ id: jobId, status: "queued" }),
    { $set: { status: "running", startedAt: now, updatedAt: now } },
    { returnDocument: "after" },
  );
  return res ?? null;
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

export async function markInterruptedSyncDbFailed(): Promise<number> {
  const running = await listRunningSyncDbJobs();
  let n = 0;
  const now = new Date().toISOString();
  for (const job of running) {
    if (isTerminalSyncDbStatus(job.status)) continue;
    const startedMs = job.startedAt ? Date.parse(job.startedAt) : Date.now();
    await updateSyncDbJob(job.id, {
      status: "failed",
      finishedAt: now,
      durationMs: Math.max(0, Date.now() - startedMs),
      exitCode: null,
      errorMessage: "Interrupted — server restarted while sync was running",
      progress: {
        ...job.progress,
        phase: "failed",
        current: [],
      },
    });
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
