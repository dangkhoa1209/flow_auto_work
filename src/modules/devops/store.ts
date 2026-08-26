import { type Collection } from "mongodb";
import { connectMongo } from "../../db/mongo.js";
import { AppError } from "../../utils/AppError.js";
import { logPathForBuild } from "./logFile.js";
import {
  isTerminalBuildStatus,
  newBuildId,
  type BuildJob,
  type BuildStatus,
} from "./types.js";

const COLLECTION = "build_jobs";

let indexesReady = false;

export async function ensureBuildIndexes(): Promise<void> {
  if (indexesReady) return;
  const db = await connectMongo();
  const col = db.collection(COLLECTION);
  await col.createIndex({ createdAt: -1 });
  await col.createIndex({ status: 1, queuedAt: 1 });
  await col.createIndex({ scriptId: 1, createdAt: -1 });
  await col.createIndex({ triggeredBy: 1, createdAt: -1 });
  indexesReady = true;
}

async function col(): Promise<Collection<BuildJob>> {
  await ensureBuildIndexes();
  return (await connectMongo()).collection<BuildJob>(COLLECTION);
}

export async function insertBuildJob(job: BuildJob): Promise<BuildJob> {
  await (await col()).insertOne(job);
  return job;
}

export async function getBuildJob(id: string): Promise<BuildJob | null> {
  const jobId = id.trim();
  if (!jobId) return null;
  return (await col()).findOne({ id: jobId });
}

export async function requireBuildJob(id: string): Promise<BuildJob> {
  const job = await getBuildJob(id);
  if (!job) throw new AppError("Build job not found", 404, "build_not_found");
  return job;
}

export async function updateBuildJob(
  id: string,
  patch: Partial<Omit<BuildJob, "id">>,
): Promise<BuildJob> {
  const updatedAt = new Date().toISOString();
  const res = await (
    await col()
  ).findOneAndUpdate(
    { id },
    { $set: { ...patch, updatedAt } },
    { returnDocument: "after" },
  );
  if (!res) {
    throw new AppError("Build job not found", 404, "build_not_found");
  }
  return res;
}

export async function listBuildJobs(opts?: {
  limit?: number;
  offset?: number;
  status?: BuildStatus;
  scriptId?: string;
}): Promise<BuildJob[]> {
  const limit = Math.min(200, Math.max(1, opts?.limit ?? 50));
  const offset = Math.max(0, opts?.offset ?? 0);
  const filter: Record<string, unknown> = {};
  if (opts?.status) filter.status = opts.status;
  if (opts?.scriptId) filter.scriptId = opts.scriptId;
  return (await col())
    .find(filter)
    .sort({ createdAt: -1 })
    .skip(offset)
    .limit(limit)
    .toArray();
}

export async function countBuildJobs(opts?: {
  status?: BuildStatus;
  scriptId?: string;
}): Promise<number> {
  const filter: Record<string, unknown> = {};
  if (opts?.status) filter.status = opts.status;
  if (opts?.scriptId) filter.scriptId = opts.scriptId;
  return (await col()).countDocuments(filter);
}

export async function listQueuedBuildJobs(): Promise<BuildJob[]> {
  return (await col())
    .find({ status: "queued" })
    .sort({ queuedAt: 1 })
    .toArray();
}

export async function listRunningBuildJobs(): Promise<BuildJob[]> {
  return (await col()).find({ status: "running" }).toArray();
}

/**
 * Atomically start the next queued job only if nothing else is running
 * anywhere in the cluster (Mongo is the global mutex).
 */
export async function tryClaimBuildJobForRun(
  jobId: string,
): Promise<BuildJob | null> {
  const c = await col();
  const otherRunning = await c.findOne({ status: "running" });
  if (otherRunning) return null;

  const now = new Date().toISOString();
  const res = await c.findOneAndUpdate(
    { id: jobId, status: "queued" },
    { $set: { status: "running", startedAt: now, updatedAt: now } },
    { returnDocument: "after" },
  );
  return res ?? null;
}

export function createQueuedBuildJob(opts: {
  scriptId: string;
  scriptLabel: string;
  command: string;
  workingDir: string;
  triggeredBy: string;
  note?: string;
}): BuildJob {
  const now = new Date().toISOString();
  const id = newBuildId();
  return {
    id,
    scriptId: opts.scriptId,
    scriptLabel: opts.scriptLabel,
    command: opts.command,
    workingDir: opts.workingDir,
    status: "queued",
    triggeredBy: opts.triggeredBy,
    note: opts.note,
    queuedAt: now,
    logFile: logPathForBuild(id),
    createdAt: now,
    updatedAt: now,
  };
}

export async function markInterruptedBuildsFailed(): Promise<number> {
  const running = await listRunningBuildJobs();
  let n = 0;
  const now = new Date().toISOString();
  for (const job of running) {
    if (isTerminalBuildStatus(job.status)) continue;
    const startedMs = job.startedAt ? Date.parse(job.startedAt) : Date.now();
    await updateBuildJob(job.id, {
      status: "failed",
      finishedAt: now,
      durationMs: Number.isFinite(startedMs) ? Date.now() - startedMs : 0,
      errorMessage: "Interrupted by server restart",
      exitCode: null,
    });
    n += 1;
  }
  return n;
}
