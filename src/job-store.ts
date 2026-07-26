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
import { fetchGitlabProject } from "./plugins/gitlab/client.js";
import {
  SEED_USERNAME,
  seedWorkspaceProjectId,
} from "./workspace/seed.js";

export async function saveJob(
  job: JobRecord,
  extra?: { source?: string; preserveUpdatedAt?: boolean },
): Promise<void> {
  if (!extra?.preserveUpdatedAt) {
    job.updatedAt = new Date().toISOString();
  } else if (!job.updatedAt) {
    job.updatedAt = job.createdAt || new Date().toISOString();
  }
  if (job.id && !job.flowTaskId) job.flowTaskId = job.id;
  await upsertJobDoc(job, extra);
  const { publishRealtime } = await import("./plugins/realtime/hub.js");
  // Patch single job status on UI — avoid spamming full jobs list refresh
  publishRealtime({
    type: "job",
    jobId: job.id,
    status: job.status,
  });
}

/** Stamp Flow user + workspace project + flowTaskId from current runtime. */
export function applyJobOwnership(
  job: JobRecord,
  opts?: { force?: boolean },
): boolean {
  const rt = getRuntimeContext();
  if (!rt) return false;
  let changed = false;
  const force = Boolean(opts?.force);

  if (force || !job.ownerUsername) {
    if (job.ownerUsername !== rt.gitlabUsername) {
      job.ownerUsername = rt.gitlabUsername;
      changed = true;
    }
  }
  if (force || !job.workspaceProjectId) {
    if (job.workspaceProjectId !== rt.projectId) {
      job.workspaceProjectId = rt.projectId;
      changed = true;
    }
  }
  if (job.id && job.flowTaskId !== job.id) {
    job.flowTaskId = job.id;
    changed = true;
  }
  if (rt.baseBranch && (force || !job.baseBranch)) {
    job.baseBranch = rt.baseBranch;
    changed = true;
  }
  if (rt.workBranch?.trim() && (force || !job.workBranch)) {
    job.workBranch = rt.workBranch.trim();
    changed = true;
  }
  return changed;
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
  if (job.id && !job.flowTaskId) job.flowTaskId = job.id;
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
    applyJobOwnership(existing);
    await saveJob(existing, { source: opts?.source });
    return existing;
  }

  const id = jobIdForIssue(issue.projectId, issue.issueIid);
  const job: JobRecord = {
    id,
    flowTaskId: id,
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
  applyJobOwnership(job, { force: true });
  await saveJob(job, { source: opts?.source ?? "ensure" });
  logger.info("Ensured draft job", {
    jobId: job.id,
    flowTaskId: job.flowTaskId,
    issueIid: issue.issueIid,
    ownerUsername: job.ownerUsername,
    workspaceProjectId: job.workspaceProjectId,
  });
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
  // Workspace has a work branch → reuse it; do not create hotfix/...
  const branch = fixedWork
    ? fixedWork
    : `hotfix/${slugifyBranchPart(title)}-${id.slice(-6)}`;
  const now = new Date().toISOString();
  const syntheticIid = syntheticAdhocIssueIid(id);

  const job: JobRecord = {
    id,
    flowTaskId: id,
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
    flowTaskId: job.flowTaskId,
    title,
    branch,
    ownerUsername: job.ownerUsername,
    workspaceProjectId: job.workspaceProjectId,
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
    flowTaskId: newId,
    kind: "issue",
    issue,
    updatedAt: now,
  };
  applyJobOwnership(migrated);

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
    flowTaskId: newId,
    issueIid: issue.issueIid,
  });
  return migrated;
}

export async function listJobs(opts?: {
  workspaceProjectId?: string;
  ownerUsername?: string;
}): Promise<JobRecord[]> {
  const docs = await listJobDocs({
    limit: 500,
    workspaceProjectId: opts?.workspaceProjectId,
    ownerUsername: opts?.ownerUsername,
  });
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
 * Legacy gate: agent finished code/commit, awaiting Approve push/MR.
 * New flow treats commit as done → migrate to succeeded.
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

/**
 * Boot: attach all existing jobs to default user + project (khoadev / ykk)
 * and ensure flowTaskId = job.id.
 */
export async function assignJobsToDefaultWorkspace(): Promise<number> {
  const workspaceProjectId = seedWorkspaceProjectId();
  const jobs = await listJobs();
  let n = 0;
  for (const job of jobs) {
    let changed = false;
    if (job.ownerUsername !== SEED_USERNAME) {
      job.ownerUsername = SEED_USERNAME;
      changed = true;
    }
    if (job.workspaceProjectId !== workspaceProjectId) {
      job.workspaceProjectId = workspaceProjectId;
      changed = true;
    }
    if (job.flowTaskId !== job.id) {
      job.flowTaskId = job.id;
      changed = true;
    }
    if (!changed) continue;
    // Keep original updatedAt so Jobs list order stays newest-first
    await saveJob(job, {
      source: "ownership_migrate",
      preserveUpdatedAt: true,
    });
    n += 1;
  }
  if (n > 0) {
    logger.info("Assigned jobs to default workspace", {
      count: n,
      ownerUsername: SEED_USERNAME,
      workspaceProjectId,
    });
  }
  return n;
}
