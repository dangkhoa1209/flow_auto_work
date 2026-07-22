import { applyIssueActions } from "../gitlab/client.js";
import { logger } from "../logger.js";

const DEFAULT_PROCESSING_LABEL = "On-processing";

export function resolveProcessingLabel(override?: string | null): string {
  const v = (override ?? DEFAULT_PROCESSING_LABEL).trim();
  return v || DEFAULT_PROCESSING_LABEL;
}

/** @deprecated use resolveProcessingLabel with job.completion.processingLabel */
export function processingLabel(override?: string | null): string {
  return resolveProcessingLabel(override);
}

/** Add processing label when a job starts working. */
export async function markIssueProcessing(opts: {
  projectId: number;
  issueIid: number;
  processingLabel?: string | null;
  extraStartLabels?: string[];
}): Promise<void> {
  const proc = resolveProcessingLabel(opts.processingLabel);
  const labels = [
    ...new Set(
      [...(opts.extraStartLabels ?? []), proc]
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
  if (!labels.length) return;
  try {
    await applyIssueActions({
      projectId: opts.projectId,
      issueIid: opts.issueIid,
      labels,
      labelMode: "add",
    });
    logger.info("Added processing labels", {
      issueIid: opts.issueIid,
      labels,
    });
  } catch (err) {
    logger.warn("Failed to add processing label", { err: String(err) });
  }
}

/** Remove processing label when handing off to QC (or on failure). */
export async function clearIssueProcessing(opts: {
  projectId: number;
  issueIid: number;
  processingLabel?: string | null;
}): Promise<void> {
  const proc = resolveProcessingLabel(opts.processingLabel);
  if (!proc) return;
  try {
    await applyIssueActions({
      projectId: opts.projectId,
      issueIid: opts.issueIid,
      removeLabels: [proc],
    });
    logger.info("Removed processing label", {
      issueIid: opts.issueIid,
      label: proc,
    });
  } catch (err) {
    logger.warn("Failed to remove processing label", { err: String(err) });
  }
}
