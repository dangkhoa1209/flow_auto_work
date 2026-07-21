import { logger } from "./logger.js";
import {
  getJobDoc,
  getJobDocByIssue,
  listJobDocs,
  upsertJobDoc,
} from "./db/mongo.js";
import type { CompletionActions, IssueJob, JobRecord } from "./types.js";
import {
  isJobBusy,
  jobIdForIssue,
  resolveDevNotes,
} from "./types.js";

export async function saveJob(
  job: JobRecord,
  extra?: { source?: string },
): Promise<void> {
  job.updatedAt = new Date().toISOString();
  // Keep legacy field in sync for old readers
  if (job.devNotes != null) job.techLeadNotes = job.devNotes;
  await upsertJobDoc(job, extra);
}

function normalizeJob(doc: JobRecord & { _id?: string; source?: string }): JobRecord {
  const { _id: _ignored, source: _src, ...rest } = doc;
  const job = rest as JobRecord;
  const notes = resolveDevNotes(job);
  if (notes) job.devNotes = notes;
  if (typeof job.runCount !== "number") job.runCount = 0;
  return job;
}

export async function loadJob(id: string): Promise<JobRecord | null> {
  const doc = await getJobDoc(id);
  if (!doc) return null;
  return normalizeJob(doc);
}

export async function loadJobByIssue(
  projectId: number,
  issueIid: number,
): Promise<JobRecord | null> {
  const doc = await getJobDocByIssue(projectId, issueIid);
  if (!doc) return null;
  return normalizeJob(doc);
}

/**
 * One task → one job. Creates `draft` if missing; refreshes issue snapshot.
 * Does not enqueue.
 */
export async function ensureJob(
  issue: IssueJob,
  opts?: {
    source?: string;
    completion?: CompletionActions;
    devNotes?: string;
  },
): Promise<JobRecord> {
  const existing = await loadJobByIssue(issue.projectId, issue.issueIid);
  const now = new Date().toISOString();

  if (existing) {
    existing.issue = issue;
    if (opts?.completion) existing.completion = opts.completion;
    if (opts?.devNotes !== undefined) {
      existing.devNotes = opts.devNotes.trim() || undefined;
    }
    await saveJob(existing, { source: opts?.source });
    return existing;
  }

  const job: JobRecord = {
    id: jobIdForIssue(issue.projectId, issue.issueIid),
    status: "draft",
    issue,
    clarifyRound: 0,
    runCount: 0,
    completion: opts?.completion,
    devNotes: opts?.devNotes?.trim() || undefined,
    createdAt: now,
    updatedAt: now,
  };
  await saveJob(job, { source: opts?.source ?? "ensure" });
  logger.info("Ensured draft job", { jobId: job.id, issueIid: issue.issueIid });
  return job;
}

export async function listJobs(): Promise<JobRecord[]> {
  const docs = await listJobDocs({ limit: 500 });
  return docs.map((doc) => normalizeJob(doc));
}

export async function listActiveIssueKeys(): Promise<Set<string>> {
  const jobs = await listJobs();
  const active = new Set<string>();
  for (const job of jobs) {
    if (isJobBusy(job.status)) {
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
    if (isJobBusy(job.status)) {
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
