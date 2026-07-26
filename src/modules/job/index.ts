/**
 * Job domain module — framework-agnostic business logic.
 * Controllers call these; no Express imports here.
 */
import { listPendingClarifications } from "../../plugins/clarify/ui-wait.js";
import { listJobDocs } from "../../db/mongo.js";
import { getConfig } from "../../config.js";
import { listAssignedOpenIssues } from "../../plugins/gitlab/client.js";
import { scanExistingAssignedIssues } from "../../plugins/gitlab/startup-scan.js";
import { jobQueue } from "../../queue.js";
import { listPendingDiffApprovals } from "../../plugins/review/diff-wait.js";
import { isJobBusy, resolveDevNotes, type CompletionActions, type JobStatus } from "../../types.js";
import { getRuntimeContext } from "../../workspace/runtime.js";
import { listJobs } from "../../job-store.js";
import { AppError } from "../../utils/AppError.js";

export * from "./lifecycle.js";
export * from "./docs.js";
export * from "./diff.js";
export * from "./merge.js";
export * from "./chat.js";

export type ListJobsQuery = {
  status?: JobStatus;
  limit?: number;
};

export async function listJobsForUi(query: ListJobsQuery = {}) {
  const limit = Number.isFinite(query.limit) ? (query.limit as number) : 50;
  const rt = getRuntimeContext();
  const jobs = await listJobDocs({
    status: query.status,
    limit,
    workspaceProjectId: rt?.projectId,
    ownerUsername: rt?.gitlabUsername,
  });
  return {
    jobs,
    pendingClarifications: listPendingClarifications(),
    pendingDiffApprovals: listPendingDiffApprovals(),
  };
}

export type StartJobsInput = {
  mode?: string;
  issueIid?: number;
  issueIids?: number[];
  runDrafts?: boolean;
  runAll?: boolean;
  devNotes?: string;
  requireDocsFirst?: boolean;
  completion?: CompletionActions;
};

function normalizeCompletion(
  body: StartJobsInput,
): CompletionActions | undefined {
  if (!body.completion) return undefined;
  return {
    assignees: body.completion.assignees
      ?.map((s) => String(s).trim())
      .filter(Boolean),
    labels: body.completion.labels
      ?.map((s) => String(s).trim())
      .filter(Boolean),
    removeLabels: body.completion.removeLabels
      ?.map((s) => String(s).trim())
      .filter(Boolean),
    onStartLabels: body.completion.onStartLabels
      ?.map((s) => String(s).trim())
      .filter(Boolean),
    processingLabel: body.completion.processingLabel?.trim() || undefined,
    labelMode:
      body.completion.labelMode === "set" ? ("set" as const) : ("add" as const),
    comment: body.completion.comment?.trim() || undefined,
  };
}

/**
 * POST /jobs/start — enqueue selected / all / auto (unchanged business rules).
 */
export async function startJobs(body: StartJobsInput) {
  const mode =
    body.mode === "selected" || body.mode === "manual"
      ? "selected"
      : body.mode === "drafts" ||
          body.mode === "all" ||
          body.runDrafts ||
          body.runAll
        ? "all"
        : "auto";
  const devNotes = body.devNotes?.trim() || undefined;
  const requireDocsFirst =
    body.requireDocsFirst !== undefined
      ? Boolean(body.requireDocsFirst)
      : undefined;
  const completion = normalizeCompletion(body);

  if (mode === "all") {
    const config = getConfig();
    const issues = await listAssignedOpenIssues();
    const existingJobs = await listJobs();
    const jobByIid = new Map(
      existingJobs.map((j) => [j.issue.issueIid, j] as const),
    );

    let enqueued = 0;
    let skipped = 0;
    let skippedBusy = 0;
    let created = 0;
    const jobIds: string[] = [];

    for (const issue of issues) {
      if (
        issue.labels.some((l) => config.skipLabels.includes(l.toLowerCase()))
      ) {
        skipped += 1;
        continue;
      }

      const existing = jobByIid.get(issue.issueIid);
      if (existing && isJobBusy(existing.status)) {
        skippedBusy += 1;
        skipped += 1;
        continue;
      }

      const wasMissing = !existing;
      const result = await jobQueue.enqueue(issue, {
        source: "ui_run_all",
        completion: completion ?? existing?.completion,
        devNotes:
          resolveDevNotes(existing ?? { devNotes: undefined }) || undefined,
        requireDocsFirst: existing?.requireDocsFirst,
      });
      if (result.enqueued && result.jobId) {
        enqueued += 1;
        if (wasMissing) created += 1;
        jobIds.push(result.jobId);
      } else {
        skipped += 1;
      }
    }

    return {
      mode: "all" as const,
      found: issues.length,
      enqueued,
      skipped,
      skippedBusy,
      created,
      jobIds,
    };
  }

  if (mode === "auto") {
    if (!completion && !devNotes) {
      const result = await scanExistingAssignedIssues({
        source: "ui_auto",
        includeSucceeded: false,
      });
      return { mode, ...result };
    }
    const all = await listAssignedOpenIssues();
    const config = getConfig();
    let enqueued = 0;
    let skipped = 0;
    const jobIds: string[] = [];
    for (const issue of all) {
      if (
        issue.labels.some((l) => config.skipLabels.includes(l.toLowerCase()))
      ) {
        skipped += 1;
        continue;
      }
      const result = await jobQueue.enqueue(issue, {
        source: "ui_auto",
        completion,
        devNotes,
      });
      if (result.enqueued && result.jobId) {
        enqueued += 1;
        jobIds.push(result.jobId);
      } else skipped += 1;
    }
    return {
      mode,
      found: all.length,
      enqueued,
      skipped,
      jobIds,
    };
  }

  const iids = Array.isArray(body.issueIids)
    ? body.issueIids.map(Number).filter((n) => !Number.isNaN(n))
    : [];
  if (body.issueIid != null && !Number.isNaN(Number(body.issueIid))) {
    const one = Number(body.issueIid);
    if (!iids.includes(one)) iids.push(one);
  }
  if (iids.length === 0) {
    throw new AppError(
      "issueIid or issueIids required for mode=selected|manual",
      400,
    );
  }

  const all = await listAssignedOpenIssues();
  const config = getConfig();
  const selected = all.filter((i) => iids.includes(i.issueIid));
  let enqueued = 0;
  let skipped = 0;
  const jobIds: string[] = [];

  for (const issue of selected) {
    if (issue.labels.some((l) => config.skipLabels.includes(l.toLowerCase()))) {
      skipped += 1;
      continue;
    }
    const result = await jobQueue.enqueue(issue, {
      source: "ui_selected",
      completion,
      devNotes: iids.length === 1 ? devNotes : undefined,
      requireDocsFirst: iids.length === 1 ? requireDocsFirst : undefined,
    });
    if (result.enqueued && result.jobId) {
      enqueued += 1;
      jobIds.push(result.jobId);
    } else {
      skipped += 1;
    }
  }

  const missing = iids.filter((id) => !selected.some((s) => s.issueIid === id));
  return {
    mode,
    found: selected.length,
    enqueued,
    skipped,
    missing,
    jobIds,
  };
}
