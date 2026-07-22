import { getConfig } from "../config.js";
import { applyIssueActions } from "../gitlab/client.js";
import { logger } from "../logger.js";

export function processingLabel(): string {
  return (getConfig().PROCESSING_LABEL || "on-processing").trim();
}

/** Add processing label when a job starts working. */
export async function markIssueProcessing(opts: {
  projectId: number;
  issueIid: number;
  extraStartLabels?: string[];
}): Promise<void> {
  const proc = processingLabel();
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
}): Promise<void> {
  const proc = processingLabel();
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
