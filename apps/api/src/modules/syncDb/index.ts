import {
  getEffectiveBaFeatures,
  getBaProject,
  isBaDbAccessAllowed,
} from "../../workspace/baStore.js";
import { AppError } from "../../utils/AppError.js";
import { subscribeSyncDbEvents } from "./events.js";
import { parseLogLines, readSyncDbLogTail } from "./logFile.js";
import { syncDbQueue } from "./queue.js";
import {
  countSyncDbJobs,
  ensureSyncDbIndexes,
  getSyncDbJob,
  listSyncDbJobs,
  requireSyncDbJobForProject,
} from "./store.js";
import {
  getSyncDbSystemConfig,
  getSyncDbSystemConfigPublic,
  isSyncDbSystemReady,
  updateSyncDbSystemConfig,
} from "./systemConfig.js";
import type {
  SyncDbCapability,
  SyncDbJob,
  SyncDbQueueSnapshot,
  SyncDbSystemConfigPatch,
} from "./types.js";

export { syncDbQueue } from "./queue.js";
export { subscribeSyncDbEvents } from "./events.js";
export { ensureSyncDbIndexes } from "./store.js";
export {
  getSyncDbSystemConfigPublic,
  updateSyncDbSystemConfig,
  resolveSyncDbSystemConfig,
} from "./systemConfig.js";
export type {
  SyncDbCapability,
  SyncDbEvent,
  SyncDbJob,
  SyncDbJobPublic,
  SyncDbLogLine,
  SyncDbProgress,
  SyncDbQueueSnapshot,
  SyncDbStatus,
  SyncDbSystemConfigPublic,
  SyncDbSystemConfigPatch,
} from "./types.js";

export async function getSyncDbCapability(
  projectId: string,
): Promise<SyncDbCapability> {
  const features = await getEffectiveBaFeatures();
  const featureVisible = features.flags.syncDatabase !== "hide";
  const systemConfigured = isSyncDbSystemReady(await getSyncDbSystemConfig());
  const project = await getBaProject(projectId);
  const projectReady = Boolean(
    project &&
      isBaDbAccessAllowed(project) &&
      project.db?.dialect === "mongodb",
  );
  const dbName =
    projectReady && project?.db?.database ? project.db.database : null;

  let reason: string | undefined;
  if (!featureVisible) reason = "feature_hidden";
  else if (!systemConfigured) reason = "system_not_configured";
  else if (!projectReady) reason = "project_not_ready";

  return {
    available: featureVisible && systemConfigured && projectReady,
    reason,
    systemConfigured,
    featureVisible,
    projectReady,
    dbName,
  };
}

export async function triggerSyncDb(opts: {
  projectId: string;
  triggeredBy: string;
}): Promise<SyncDbJob> {
  const cap = await getSyncDbCapability(opts.projectId);
  if (!cap.featureVisible) {
    throw new AppError(
      "Sync Database feature is hidden",
      403,
      "sync_db_feature_hidden",
    );
  }
  if (!cap.available) {
    throw new AppError(
      cap.reason === "system_not_configured"
        ? "Sync Database is not configured by admin"
        : "Project must have MongoDB Connect DB enabled",
      409,
      cap.reason || "sync_db_unavailable",
    );
  }
  return syncDbQueue.trigger(opts);
}

export async function cancelSyncDb(
  jobId: string,
  reason?: string,
  opts?: { projectId?: string },
): Promise<SyncDbJob> {
  return syncDbQueue.cancel(jobId, reason, opts);
}

export async function getSyncDb(
  jobId: string,
  opts?: { projectId?: string },
): Promise<SyncDbJob> {
  const projectId = String(opts?.projectId || "").trim();
  if (!projectId) {
    throw new AppError(
      "projectId required",
      400,
      "sync_db_project_required",
    );
  }
  return requireSyncDbJobForProject(jobId, projectId);
}

export async function listSyncDbs(opts?: {
  limit?: number;
  offset?: number;
  status?: SyncDbJob["status"];
  projectId?: string;
}): Promise<SyncDbJob[]> {
  const projectId = String(opts?.projectId || "").trim();
  if (!projectId) {
    throw new AppError(
      "projectId required to list sync jobs",
      400,
      "sync_db_project_required",
    );
  }
  return listSyncDbJobs({ ...opts, projectId });
}

export async function countSyncDbs(opts?: {
  status?: SyncDbJob["status"];
  projectId?: string;
}): Promise<number> {
  const projectId = String(opts?.projectId || "").trim();
  if (!projectId) {
    throw new AppError(
      "projectId required",
      400,
      "sync_db_project_required",
    );
  }
  return countSyncDbJobs({ ...opts, projectId });
}

export function getSyncDbQueueSnapshot(): SyncDbQueueSnapshot {
  return syncDbQueue.snapshot();
}

export async function readSyncDbLog(
  jobId: string,
  opts?: { projectId?: string },
): Promise<{
  job: SyncDbJob;
  text: string;
  lines: ReturnType<typeof parseLogLines>;
}> {
  const projectId = String(opts?.projectId || "").trim();
  if (!projectId) {
    throw new AppError(
      "projectId required",
      400,
      "sync_db_project_required",
    );
  }
  const job = await requireSyncDbJobForProject(jobId, projectId);
  const text = await readSyncDbLogTail(job.logFile);
  return { job, text, lines: parseLogLines(text) };
}

export async function restoreSyncDbQueue(): Promise<number> {
  await ensureSyncDbIndexes();
  return syncDbQueue.restoreQueued();
}

export async function shutdownSyncDbQueue(timeoutMs?: number): Promise<void> {
  await syncDbQueue.gracefulShutdown(timeoutMs);
}

export async function adminGetSyncDbConfig() {
  return getSyncDbSystemConfigPublic();
}

export async function adminUpdateSyncDbConfig(
  patch: SyncDbSystemConfigPatch,
  updatedBy: string,
) {
  return updateSyncDbSystemConfig(patch, updatedBy);
}

export { getSyncDbJob, parseLogLines, readSyncDbLogTail };
