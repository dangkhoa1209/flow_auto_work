import { logger } from "./logger.js";
import {
  getJobDoc,
  listJobDocs,
  upsertJobDoc,
} from "./db/mongo.js";
import type { JobRecord } from "./types.js";

export async function saveJob(
  job: JobRecord,
  extra?: { source?: string },
): Promise<void> {
  job.updatedAt = new Date().toISOString();
  await upsertJobDoc(job, extra);
}

export async function loadJob(id: string): Promise<JobRecord | null> {
  const doc = await getJobDoc(id);
  if (!doc) return null;
  const { _id: _ignored, source: _src, ...job } = doc;
  return job as JobRecord;
}

export async function listJobs(): Promise<JobRecord[]> {
  const docs = await listJobDocs({ limit: 500 });
  return docs.map((doc) => {
    const { _id: _ignored, source: _src, ...job } = doc;
    return job as JobRecord;
  });
}

export async function listActiveIssueKeys(): Promise<Set<string>> {
  const jobs = await listJobs();
  const active = new Set<string>();
  for (const job of jobs) {
    if (
      job.status === "queued" ||
      job.status === "running" ||
      job.status === "awaiting_clarification"
    ) {
      active.add(`${job.issue.projectId}:${job.issue.issueIid}`);
    }
  }
  return active;
}

export function issueKey(projectId: number, issueIid: number): string {
  return `${projectId}:${issueIid}`;
}

/** Mark interrupted jobs failed after process restart (safe default). */
export async function failInterruptedJobs(): Promise<void> {
  const jobs = await listJobs();
  for (const job of jobs) {
    if (
      job.status === "queued" ||
      job.status === "running" ||
      job.status === "awaiting_clarification"
    ) {
      job.status = "failed";
      job.error =
        job.error ??
        "Interrupted by process restart. Re-assign or update the issue to retry.";
      await saveJob(job);
      logger.warn("Marked interrupted job as failed", { jobId: job.id });
    }
  }
}

/**
 * Legacy gate: agent đã code/commit xong, chờ Approve push/MR.
 * Flow mới coi commit = done → migrate sang succeeded.
 */
export async function resolveLegacyDiffApprovalJobs(): Promise<number> {
  const jobs = await listJobs();
  let n = 0;
  for (const job of jobs) {
    if (job.status !== "awaiting_diff_approval") continue;
    job.status = "succeeded";
    job.error = undefined;
    if (!job.summary) {
      job.summary =
        "Legacy awaiting_diff_approval → succeeded (done at local commit; push/MR gate removed).";
    }
    await saveJob(job);
    n += 1;
    logger.info("Resolved legacy awaiting_diff_approval → succeeded", {
      jobId: job.id,
      issueIid: job.issue.issueIid,
    });
  }
  return n;
}
