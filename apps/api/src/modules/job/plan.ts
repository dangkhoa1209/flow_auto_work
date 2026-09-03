/**
 * Plan-first phase: agent explores in Cursor plan mode, then PM approves → code.
 */
import { loadJob, saveJob } from "../../job-store.js";
import { jobQueue } from "../../queue.js";
import { resolveDevNotes } from "../../types.js";
import { AppError } from "../../utils/AppError.js";
import { requireJobRecord } from "./lifecycle.js";
import { requireProjectLocalClone } from "../../workspace/resolve.js";

/** PM approves the plan → enqueue code phase (skip plan). */
export async function approveJobPlan(jobId: string) {
  const job = await requireJobRecord(jobId, "job not found");
  if (job.status !== "awaiting_plan_approval") {
    throw new AppError(
      "Approve plan only when status is awaiting_plan_approval",
      409,
    );
  }
  if (job.workspaceProjectId) {
    await requireProjectLocalClone(job.workspaceProjectId);
  }
  const result = await jobQueue.enqueueCodeAfterPlanApproval(job.id);
  if (!result.enqueued) {
    throw new AppError(result.reason ?? "Could not enqueue", 409);
  }
  const updated = await loadJob(job.id);
  return { ok: true, job: updated, jobId: result.jobId };
}

/** Re-run plan phase (from awaiting_plan_approval or with flag). */
export async function rerunJobPlan(jobId: string) {
  const job = await requireJobRecord(jobId, "job not found");
  job.planFirst = true;
  job.planApprovedAt = undefined;
  await saveJob(job);
  if (job.workspaceProjectId) {
    await requireProjectLocalClone(job.workspaceProjectId);
  }
  const result = await jobQueue.enqueue(job.issue, {
    source: "ui_rerun_plan",
    completion: job.completion,
    devNotes: resolveDevNotes(job) || undefined,
    requireDocsFirst: job.requireDocsFirst,
    planFirst: true,
    forceCodePhase: Boolean(job.docsApprovedAt),
    forceAgentPhase: false,
  });
  if (!result.enqueued) {
    throw new AppError(result.reason ?? "Could not enqueue", 409);
  }
  return { ok: true, jobId: result.jobId };
}
