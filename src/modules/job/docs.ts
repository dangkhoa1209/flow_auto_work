/**
 * Feature-docs phase: read docs for PM review, approve, re-run.
 */
import { loadJob, saveJob } from "../../job-store.js";
import { jobQueue } from "../../queue.js";
import { isJobBusy, resolveDevNotes } from "../../types.js";
import { AppError } from "../../utils/AppError.js";
import { requireJobRecord } from "./lifecycle.js";
import { requireProjectLocalClone } from "../../workspace/resolve.js";

/** Feature docs (.md/.mdc) for PM review while awaiting_docs_approval. */
export async function getJobDocsForReview(jobId: string) {
  const job = await requireJobRecord(jobId, "job not found");
  const { readRepoDocs } = await import("../../plugins/docs/analysis.js");
  const { resolveRepoPath } = await import("../../workspace/creds.js");
  const paths = job.docsPaths?.length
    ? job.docsPaths
    : job.docsPath
      ? [job.docsPath]
      : [];
  const files = paths.length ? await readRepoDocs(resolveRepoPath(), paths) : [];
  return {
    jobId: job.id,
    status: job.status,
    requireDocsFirst: Boolean(job.requireDocsFirst),
    docsSummary: job.docsSummary ?? null,
    docsApprovedAt: job.docsApprovedAt ?? null,
    paths,
    files,
  };
}

/** PM approves feature docs → enqueue code phase. */
export async function approveJobDocs(jobId: string) {
  const job = await requireJobRecord(jobId, "job not found");
  if (job.status !== "awaiting_docs_approval") {
    throw new AppError(
      "Approve docs only when status is awaiting_docs_approval",
      409,
    );
  }
  if (job.workspaceProjectId) {
    await requireProjectLocalClone(job.workspaceProjectId);
  }
  const result = await jobQueue.enqueueCodeAfterDocsApproval(job.id);
  if (!result.enqueued) {
    throw new AppError(result.reason ?? "Could not enqueue", 409);
  }
  const updated = await loadJob(job.id);
  return { ok: true, job: updated, jobId: result.jobId };
}

/** Re-run docs phase only (from awaiting_docs_approval or with flag). */
export async function rerunJobDocs(jobId: string) {
  const job = await requireJobRecord(jobId, "job not found");
  if (isJobBusy(job.status)) {
    throw new AppError("Job is busy", 409);
  }
  job.requireDocsFirst = true;
  job.docsApprovedAt = undefined;
  await saveJob(job);
  if (job.workspaceProjectId) {
    await requireProjectLocalClone(job.workspaceProjectId);
  }
  const result = await jobQueue.enqueue(job.issue, {
    source: "ui_rerun_docs",
    completion: job.completion,
    devNotes: resolveDevNotes(job) || undefined,
    requireDocsFirst: true,
    forceCodePhase: false,
  });
  if (!result.enqueued) {
    throw new AppError(result.reason ?? "Could not enqueue", 409);
  }
  return { ok: true, jobId: result.jobId };
}
