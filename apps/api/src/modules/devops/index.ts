import {
  createBuildScript,
  deleteBuildScript,
  removeLocalDevSmokeScript,
  listWhitelistedScripts,
  requireWhitelistedScript,
  seedBuildScriptsIfEmpty,
  updateBuildScript,
  type ScriptInput,
} from "./catalog.js";
import { subscribeBuildEvents } from "./events.js";
import { parseLogLines, readBuildLogTail } from "./logFile.js";
import { buildQueue } from "./queue.js";
import { writeBuildStdin } from "./runner.js";
import {
  countBuildJobs,
  ensureBuildIndexes,
  getBuildJob,
  listBuildJobs,
  requireBuildJob,
} from "./store.js";
import { AppError } from "../../utils/AppError.js";
import type { BuildJob, BuildQueueSnapshot } from "./types.js";

export { buildQueue } from "./queue.js";
export { subscribeBuildEvents } from "./events.js";
export { ensureBuildIndexes } from "./store.js";
export { listWhitelistedScripts, requireWhitelistedScript } from "./catalog.js";
export type {
  BuildEvent,
  BuildJob,
  BuildJobPublic,
  BuildLogLine,
  BuildQueueSnapshot,
  BuildStatus,
  WhitelistedScript,
} from "./types.js";

export async function listBuildScripts() {
  return listWhitelistedScripts();
}

export async function addBuildScript(raw: ScriptInput, createdBy: string) {
  return createBuildScript(raw, createdBy);
}

export async function patchBuildScript(scriptId: string, raw: ScriptInput) {
  return updateBuildScript(scriptId, raw);
}

export async function removeBuildScript(scriptId: string) {
  return deleteBuildScript(scriptId);
}

export async function triggerBuild(opts: {
  scriptId: string;
  triggeredBy: string;
  note?: string;
}): Promise<BuildJob> {
  const script = await requireWhitelistedScript(opts.scriptId);
  if (script.active === false) {
    throw new AppError(
      "This script is inactive — enable it in the Config tab before running",
      409,
      "script_inactive",
    );
  }
  return buildQueue.trigger(opts);
}

export async function cancelBuild(
  jobId: string,
  reason?: string,
): Promise<BuildJob> {
  return buildQueue.cancel(jobId, reason);
}

export function sendBuildStdin(
  jobId: string,
  data: string,
  secret = false,
): void {
  writeBuildStdin(jobId, data, secret);
}

export async function getBuild(jobId: string): Promise<BuildJob> {
  return requireBuildJob(jobId);
}

export async function listBuilds(opts?: {
  limit?: number;
  offset?: number;
  status?: BuildJob["status"];
  scriptId?: string;
}): Promise<BuildJob[]> {
  return listBuildJobs(opts);
}

export async function countBuilds(opts?: {
  status?: BuildJob["status"];
  scriptId?: string;
}): Promise<number> {
  return countBuildJobs(opts);
}

export function getBuildQueueSnapshot(): BuildQueueSnapshot {
  return buildQueue.snapshot();
}

export async function readBuildLog(jobId: string): Promise<{
  job: BuildJob;
  text: string;
  lines: ReturnType<typeof parseLogLines>;
}> {
  const job = await requireBuildJob(jobId);
  const text = await readBuildLogTail(job.logFile);
  return { job, text, lines: parseLogLines(text) };
}

export async function restoreBuildQueue(): Promise<number> {
  await ensureBuildIndexes();
  await seedBuildScriptsIfEmpty();
  await removeLocalDevSmokeScript();
  return buildQueue.restoreQueued();
}

export async function shutdownBuildQueue(timeoutMs?: number): Promise<void> {
  await buildQueue.gracefulShutdown(timeoutMs);
}

export { getBuildJob, parseLogLines, readBuildLogTail, writeBuildStdin };
