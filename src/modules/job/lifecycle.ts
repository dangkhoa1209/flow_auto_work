/**
 * Job lifecycle logic — create / open / inspect / stop / delete.
 * Framework-agnostic: no Express types here.
 */
import { getJobProgress, getJobTokenUsage } from "../../plugins/agent/progress.js";
import {
  deleteJobDoc,
  deleteJobSideDocs,
  getJobDoc,
  listChatMessages,
  listNotes,
} from "../../db/mongo.js";
import {
  commentOnIssue,
  createIssue,
  fetchIssueAsJob,
  listAssignedOpenIssues,
} from "../../plugins/gitlab/client.js";
import {
  createAdhocJob,
  ensureJob,
  listJobs,
  loadJob,
  loadJobByIssue,
  migrateAdhocJobToIssue,
  saveJob,
} from "../../job-store.js";
import { logger } from "../../logger.js";
import { jobQueue } from "../../queue.js";
import { getRuntimeContext } from "../../workspace/runtime.js";
import { isAwaitingDiffApproval } from "../../plugins/review/diff-wait.js";
import {
  isAdhocJob,
  isJobBusy,
  type IssueJob,
  type JobRecord,
  type JobStatus,
} from "../../types.js";
import { AppError } from "../../utils/AppError.js";

/** Job doc or 404 — mirrors the Hono `{ error: "not found" }` shape. */
export async function requireJobDoc(id: string) {
  const job = await getJobDoc(id);
  if (!job) throw new AppError("not found", 404);
  return job;
}

/** Normalized job or 404 with the legacy `job not found` message. */
export async function requireJobRecord(
  id: string,
  message = "not found",
): Promise<JobRecord> {
  const job = await loadJob(id);
  if (!job) throw new AppError(message, 404);
  return job;
}

export type EnsureJobInput = {
  issueIid?: number;
  devNotes?: string;
  requireDocsFirst?: boolean;
};

/** Open/create the unique job for an issue (status draft if new). */
export async function ensureJobForIssue(
  input: EnsureJobInput,
): Promise<{ job: JobRecord }> {
  const iid = Number(input.issueIid);
  if (!Number.isFinite(iid) || iid <= 0) {
    throw new AppError("issueIid required", 400);
  }
  // Prefer assignee list (fresh), else fetch any issue by iid (Related/child),
  // else reuse existing job snapshot.
  const all = await listAssignedOpenIssues();
  let issue = all.find((i) => i.issueIid === iid) ?? null;
  if (!issue) {
    issue = await fetchIssueAsJob(iid);
  }
  if (!issue) {
    const existing = (await listJobs()).find((j) => j.issue.issueIid === iid);
    if (!existing) throw new AppError(`Issue #${iid} not found`, 404);
    if (input.devNotes !== undefined) {
      existing.devNotes = input.devNotes.trim() || undefined;
    }
    if (input.requireDocsFirst !== undefined) {
      existing.requireDocsFirst = Boolean(input.requireDocsFirst);
    }
    await saveJob(existing);
    return { job: existing };
  }
  const job = await ensureJob(issue, {
    source: "ui_ensure",
    devNotes: input.devNotes,
    requireDocsFirst: input.requireDocsFirst,
  });
  return { job };
}

export type AdhocJobInput = {
  title?: string;
  message?: string;
  labels?: string[];
};

/** Free Hotfix / ad-hoc agent session (no GitLab issue yet). */
export async function createAdhocSession(input: AdhocJobInput) {
  const title = input.title?.trim();
  if (!title) throw new AppError("title required", 400);
  try {
    const job = await createAdhocJob({
      title,
      labels: input.labels,
      source: "ui_adhoc",
    });
    const message = input.message?.trim();
    if (message) {
      // Fire follow-up async so UI can select job + stream progress
      void jobQueue.followUpChat(job.id, message).catch((err) => {
        logger.error("Adhoc first message failed", {
          jobId: job.id,
          err: err instanceof Error ? err.message : String(err),
        });
      });
    }
    return { job, started: Boolean(message) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("Create adhoc job failed", { err: msg });
    throw new AppError(msg, 500);
  }
}

/** Prefill suggestion for the «Create GitLab issue» modal. */
export async function buildIssueDraft(jobId: string) {
  const job = await requireJobDoc(jobId);
  if (!isAdhocJob(job)) {
    throw new AppError("Only adhoc sessions can create a new issue", 400);
  }
  const chat = await listChatMessages({ jobId: job.id, limit: 40 });
  const humanBits = chat
    .filter((m) => m.role === "user" && m.body?.trim())
    .map((m) => m.body.trim())
    .slice(-5);
  const agentBits = chat
    .filter((m) => m.role === "agent" && m.body?.trim())
    .map((m) => m.body.trim())
    .slice(-3);
  const summary = (job.summary || "").trim();
  const title =
    job.issue.title?.trim() ||
    summary.split("\n")[0]?.slice(0, 120) ||
    "Hotfix session";
  const parts: string[] = [];
  if (summary) parts.push(`## Summary\n${summary}`);
  if (humanBits.length) {
    parts.push(
      `## Requests\n${humanBits.map((b) => `- ${b.slice(0, 500)}`).join("\n")}`,
    );
  }
  if (agentBits.length) {
    parts.push(
      `## Agent notes\n${agentBits.map((b) => b.slice(0, 800)).join("\n\n---\n\n")}`,
    );
  }
  if (job.branch) parts.push(`## Branch\n\`${job.branch}\``);
  if (job.commitSha) parts.push(`## Commit\n\`${job.commitSha.slice(0, 8)}\``);
  return {
    title,
    description: parts.join("\n\n") || title,
    labels: job.issue.labels || [],
    branch: job.branch || null,
    commitSha: job.commitSha || null,
    summary: summary || null,
  };
}

export type CreateIssueFromAdhocInput = {
  title?: string;
  description?: string;
  labels?: string[];
  assignee?: string;
};

/** Create GitLab issue from adhoc session and migrate job id. */
export async function createIssueFromAdhoc(
  jobId: string,
  input: CreateIssueFromAdhocInput,
) {
  const loaded = await requireJobRecord(jobId);
  if (!isAdhocJob(loaded)) {
    throw new AppError("Only adhoc sessions can create a new issue", 400);
  }
  if (isJobBusy(loaded.status)) {
    throw new AppError("Agent is running — wait for it to finish before creating an issue", 409);
  }
  const title = input.title?.trim() || loaded.issue.title?.trim();
  if (!title) throw new AppError("title required", 400);
  const description = input.description?.trim() || "";
  const labels = input.labels?.length ? input.labels : loaded.issue.labels || [];

  const { getRuntimeContext } = await import("../../workspace/runtime.js");
  const rt = getRuntimeContext();
  const assignee =
    input.assignee?.trim().replace(/^@/, "") ||
    loaded.ownerUsername?.trim() ||
    rt?.gitlabUsername?.trim() ||
    "";

  try {
    const created = await createIssue({
      title,
      description,
      labels,
      assignees: assignee ? [assignee] : undefined,
      projectIdOrPath: loaded.issue.projectId || loaded.issue.projectPath,
    });

    const issue: IssueJob = {
      projectId: created.projectId,
      projectPath: loaded.issue.projectPath,
      issueIid: created.iid,
      issueId: created.id,
      title: created.title,
      description: created.description,
      labels: created.labels.length ? created.labels : labels,
      url: created.webUrl,
      action: "adhoc_linked",
    };

    const migrated = await migrateAdhocJobToIssue(loaded, issue);

    const commentParts = ["Linked from Flow Auto Work ad-hoc / Hotfix session."];
    if (assignee) commentParts.push(`Assignee: @${assignee}`);
    if (migrated.branch) commentParts.push(`Branch: \`${migrated.branch}\``);
    if (migrated.commitSha) {
      commentParts.push(`Commit: \`${migrated.commitSha.slice(0, 12)}\``);
    }
    if (migrated.summary?.trim()) {
      commentParts.push(`\n### Summary\n${migrated.summary.trim()}`);
    }
    await commentOnIssue(
      created.projectId,
      created.iid,
      commentParts.join("\n"),
    ).catch((err) => {
      logger.warn("Post-create issue comment failed", {
        err: String(err),
        iid: created.iid,
      });
    });

    return {
      job: migrated,
      issueUrl: created.webUrl,
      assignee: created.assignees[0] || assignee || null,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("create-issue failed", { jobId: loaded.id, err: msg });
    throw new AppError(msg, 500);
  }
}

export type DevNotesInput = {
  devNotes?: string;
  requireDocsFirst?: boolean;
};

export async function updateDevNotes(jobId: string, input: DevNotesInput) {
  const job = await requireJobRecord(jobId, "job not found");
  if (input.devNotes !== undefined) {
    // Keep user whitespace while typing/autosave; only treat all-blank as empty
    job.devNotes =
      input.devNotes.trim() === "" ? undefined : input.devNotes;
  }
  if (input.requireDocsFirst !== undefined) {
    job.requireDocsFirst = Boolean(input.requireDocsFirst);
  }
  await saveJob(job);
  return { job };
}

export async function findJobByIssueIid(iid: number) {
  if (!Number.isFinite(iid) || iid <= 0) {
    throw new AppError("invalid iid", 400);
  }
  const all = await listAssignedOpenIssues();
  const issue = all.find((i) => i.issueIid === iid);
  if (issue) {
    const job = await loadJobByIssue(issue.projectId, iid);
    return { job };
  }
  const fallback = (await listJobs()).find((j) => j.issue.issueIid === iid);
  return { job: fallback ?? null };
}

export async function getJobDetail(jobId: string) {
  const job = await requireJobDoc(jobId);
  const [notes, chat] = await Promise.all([
    listNotes({ jobId: job.id, limit: 50 }),
    listChatMessages({ jobId: job.id, limit: 200 }),
  ]);
  const { redactJobGoogleAuthForClient } = await import(
    "../google/index.js"
  );
  return {
    job: redactJobGoogleAuthForClient(job),
    notes,
    chat,
    pendingQuestion:
      job.status === "awaiting_clarification" ? job.lastQuestion : null,
    awaitingDiffApproval:
      job.status === "awaiting_diff_approval" || isAwaitingDiffApproval(job.id),
  };
}

export async function getJobProgressForUi(jobId: string, after: number) {
  const job = await requireJobDoc(jobId);
  const { lines, latestId } = getJobProgress(
    jobId,
    Number.isFinite(after) ? after : 0,
  );
  const { hasActiveAgentRun } = await import("../../plugins/agent/run.js");
  const live =
    hasActiveAgentRun(jobId) ||
    ["queued", "running"].includes(job.status);
  const liveUsage = getJobTokenUsage(jobId);
  const tokenUsage = liveUsage
    ? {
        inputTokens: liveUsage.inputTokens,
        outputTokens: liveUsage.outputTokens,
        totalTokens: liveUsage.totalTokens,
        lastInputTokens: liveUsage.lastInputTokens,
        contextWindow: liveUsage.contextWindow,
        contextPct: liveUsage.contextPct,
        updatedAt: liveUsage.updatedAt,
      }
    : job.tokenUsage ?? null;
  return {
    jobId,
    status: job.status,
    agentId: job.agentId ?? null,
    lines,
    latestId,
    live,
    tokenUsage,
  };
}

export async function killJob(jobId: string, reason?: string) {
  return jobQueue.killJob(jobId, reason?.trim() || "Force-stopped from UI");
}

/** Stop every queued/running job in the current workspace project. */
export async function killAllJobs(reason?: string) {
  const rt = getRuntimeContext();
  return jobQueue.killAllJobs({
    workspaceProjectId: rt?.projectId,
    ownerUsername: rt?.gitlabUsername,
    reason: reason?.trim() || "Kill all from UI",
  });
}

/** Drop Cursor agent window; next Run/chat creates a fresh one. */
export async function resetJobWindow(jobId: string) {
  try {
    const result = await jobQueue.resetAgentWindow(jobId);
    return {
      ok: result.ok,
      killed: result.killed,
      previousAgentId: result.previousAgentId ?? null,
      job: result.job,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new AppError(msg, /not found/i.test(msg) ? 404 : 500);
  }
}

/** Manual status override (draft / handoff / done / failed). */
export const MANUAL_STATUSES = new Set<JobStatus>([
  "draft",
  "awaiting_handoff",
  "succeeded",
  "failed",
]);

export type SetJobStatusResult =
  | { ok: true; job: JobRecord }
  | { ok: false; reason: "invalid_status"; allowed: JobStatus[] }
  | { ok: false; reason: "busy"; status: JobStatus };

export async function setJobStatus(
  jobId: string,
  input: { status?: string; force?: boolean },
): Promise<SetJobStatusResult> {
  const job = await requireJobRecord(jobId);
  const next = input.status as JobStatus | undefined;
  if (!next || !MANUAL_STATUSES.has(next)) {
    return {
      ok: false,
      reason: "invalid_status",
      allowed: [...MANUAL_STATUSES],
    };
  }
  if (isJobBusy(job.status)) {
    if (!input.force) {
      return { ok: false, reason: "busy", status: job.status };
    }
    await jobQueue.killJob(jobId, "Stopped before manual status change");
  }
  job.status = next;
  if (next === "succeeded" || next === "awaiting_handoff") {
    job.error = undefined;
  }
  if (next === "failed" && !job.error) {
    job.error = "Marked failed from UI";
  }
  await saveJob(job, { source: "manual-status" });
  return { ok: true, job };
}

export type DeleteJobResult =
  | { ok: true; jobId: string; chat: number; notes: number }
  | { ok: false; reason: "busy"; status: JobStatus };

export async function deleteJob(
  jobId: string,
  force: boolean,
): Promise<DeleteJobResult> {
  const job = await requireJobRecord(jobId);
  if (isJobBusy(job.status)) {
    if (!force) {
      return { ok: false, reason: "busy", status: job.status };
    }
    await jobQueue.killJob(jobId, "Stopped before delete");
  }
  const side = await deleteJobSideDocs(jobId);
  const deleted = await deleteJobDoc(jobId);
  if (!deleted) throw new AppError("not found", 404);
  const { publishRealtime } = await import("../../plugins/realtime/hub.js");
  publishRealtime({ type: "jobs", reason: "delete", jobId });
  logger.info("job deleted from UI", { jobId, side });
  return { ok: true, jobId, ...side };
}

export async function getLinkedIssueContext(jobId: string) {
  const job = await requireJobDoc(jobId);
  const { collectLinkedIssueContext } = await import(
    "../../plugins/gitlab/linked-context.js"
  );
  const linked = await collectLinkedIssueContext(job.issue);
  return {
    jobId: job.id,
    issueIid: job.issue.issueIid,
    linked: linked.linked,
    comments: linked.commentExcerpts,
  };
}
