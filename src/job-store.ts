import { logger } from "./logger.js";
import {
  deleteJobDoc,
  getJobDoc,
  getJobDocByIssue,
  listJobDocs,
  rekeyJobSideDocs,
  upsertJobDoc,
} from "./db/mongo.js";
import type { CompletionActions, IssueJob, JobRecord } from "./types.js";
import {
  isJobBusy,
  jobIdForIssue,
  newAdhocJobId,
  resolveDevNotes,
  slugifyBranchPart,
  syntheticAdhocIssueIid,
} from "./types.js";
import { getRuntimeContext } from "./workspace/runtime.js";
import { fetchGitlabProject } from "./gitlab/client.js";

export async function saveJob(
  job: JobRecord,
  extra?: { source?: string },
): Promise<void> {
  job.updatedAt = new Date().toISOString();
  // Keep legacy field in sync for old readers
  if (job.devNotes != null) job.techLeadNotes = job.devNotes;
  await upsertJobDoc(job, extra);
  const { publishRealtime } = await import("./realtime/hub.js");
  // Patch single job status on UI — avoid spamming full jobs list refresh
  publishRealtime({
    type: "job",
    jobId: job.id,
    status: job.status,
  });
}

function normalizeJob(doc: JobRecord & { _id?: string; source?: string }): JobRecord {
  const { _id: _ignored, source: _src, ...rest } = doc;
  const job = rest as JobRecord;
  const notes = resolveDevNotes(job);
  if (notes) job.devNotes = notes;
  if (typeof job.runCount !== "number") job.runCount = 0;
  if (!job.kind) {
    job.kind =
      job.issue?.action === "adhoc" || (job.issue?.issueIid ?? 1) <= 0
        ? "adhoc"
        : "issue";
  }
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
    requireDocsFirst?: boolean;
  },
): Promise<JobRecord> {
  const existing = await loadJobByIssue(issue.projectId, issue.issueIid);
  const now = new Date().toISOString();

  if (existing) {
    existing.issue = issue;
    existing.kind = "issue";
    if (opts?.completion) existing.completion = opts.completion;
    if (opts?.devNotes !== undefined) {
      existing.devNotes = opts.devNotes.trim() || undefined;
    }
    if (opts?.requireDocsFirst !== undefined) {
      existing.requireDocsFirst = opts.requireDocsFirst;
    }
    await saveJob(existing, { source: opts?.source });
    return existing;
  }

  const job: JobRecord = {
    id: jobIdForIssue(issue.projectId, issue.issueIid),
    status: "draft",
    kind: "issue",
    issue,
    clarifyRound: 0,
    runCount: 0,
    completion: opts?.completion,
    devNotes: opts?.devNotes?.trim() || undefined,
    requireDocsFirst: opts?.requireDocsFirst,
    createdAt: now,
    updatedAt: now,
  };
  await saveJob(job, { source: opts?.source ?? "ensure" });
  logger.info("Ensured draft job", { jobId: job.id, issueIid: issue.issueIid });
  return job;
}

/** Create a free Hotfix / ad-hoc agent session (no GitLab issue yet). */
export async function createAdhocJob(opts: {
  title: string;
  labels?: string[];
  source?: string;
}): Promise<JobRecord> {
  const title = opts.title.trim();
  if (!title) throw new Error("title required");

  const rt = getRuntimeContext();
  if (!rt) throw new Error("No workspace runtime context");

  let projectId = rt.gitlabProjectId;
  if (!projectId) {
    const p = await fetchGitlabProject(rt.gitlabPath, rt.gitlabToken);
    projectId = p.id;
  }

  const id = newAdhocJobId();
  const fixedWork = rt.workBranch?.trim() || "";
  // Có work branch workspace → dùng luôn, không tạo hotfix/...
  const branch = fixedWork
    ? fixedWork
    : `hotfix/${slugifyBranchPart(title)}-${id.slice(-6)}`;
  const now = new Date().toISOString();
  const syntheticIid = syntheticAdhocIssueIid(id);

  const job: JobRecord = {
    id,
    status: "draft",
    kind: "adhoc",
    issue: {
      projectId,
      projectPath: rt.gitlabPath,
      issueIid: syntheticIid,
      issueId: 0,
      title,
      description: "",
      labels: opts.labels || [],
      url: "",
      action: "adhoc",
    },
    ownerUsername: rt.gitlabUsername,
    workspaceProjectId: rt.projectId,
    baseBranch: rt.baseBranch,
    workBranch: fixedWork || undefined,
    branch,
    clarifyRound: 0,
    runCount: 0,
    createdAt: now,
    updatedAt: now,
  };

  await saveJob(job, { source: opts.source ?? "adhoc" });
  logger.info("Created adhoc job", {
    jobId: job.id,
    title,
    branch,
    reusedWorkBranch: Boolean(fixedWork),
  });
  return job;
}

/**
 * After GitLab issue is created: rematerialize adhoc job as issue-* id.
 */
export async function migrateAdhocJobToIssue(
  adhocJob: JobRecord,
  issue: IssueJob,
): Promise<JobRecord> {
  const newId = jobIdForIssue(issue.projectId, issue.issueIid);
  if (await loadJob(newId)) {
    throw new Error(`Job already exists for #${issue.issueIid}`);
  }

  const oldId = adhocJob.id;
  const now = new Date().toISOString();
  const migrated: JobRecord = {
    ...adhocJob,
    id: newId,
    kind: "issue",
    issue,
    updatedAt: now,
  };

  await saveJob(migrated, { source: "adhoc_migrate" });
  await rekeyJobSideDocs({
    fromJobId: oldId,
    toJobId: newId,
    issueIid: issue.issueIid,
  });
  await deleteJobDoc(oldId);

  logger.info("Migrated adhoc job → issue job", {
    from: oldId,
    to: newId,
    issueIid: issue.issueIid,
  });
  return migrated;
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
