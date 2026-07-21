import { getConfig } from "../config.js";
import { listJobs } from "../job-store.js";
import { logger } from "../logger.js";
import { jobQueue } from "../queue.js";
import { listAssignedOpenIssues } from "./client.js";

function hasSkipLabel(labels: string[], skipLabels: string[]): boolean {
  const lower = labels.map((l) => l.toLowerCase());
  return skipLabels.some((s) => lower.includes(s));
}

export type ScanOptions = {
  source?: string;
  includeSucceeded?: boolean;
};

/**
 * Pull open issues assigned to you and enqueue them.
 */
export async function scanExistingAssignedIssues(
  opts: ScanOptions = {},
): Promise<{
  found: number;
  enqueued: number;
  skipped: number;
}> {
  const config = getConfig();
  const source = opts.source ?? "startup_scan";

  if (source === "startup_scan" && !config.STARTUP_SCAN) {
    logger.info("Startup scan disabled (STARTUP_SCAN=false)");
    return { found: 0, enqueued: 0, skipped: 0 };
  }

  logger.info("Scan: fetching assigned open issues", {
    project: config.ALLOWED_PROJECT_PATH,
    assignee: config.GITLAB_ASSIGNEE_USERNAME,
    source,
  });

  const issues = await listAssignedOpenIssues();
  const jobs = await listJobs();
  const includeSucceeded =
    opts.includeSucceeded ?? config.STARTUP_SCAN_INCLUDE_SUCCEEDED;
  const doneKeys = new Set(
    jobs
      .filter(
        (j) =>
          j.status === "succeeded" || j.status === "awaiting_handoff",
      )
      .map((j) => `${j.issue.projectId}:${j.issue.issueIid}`),
  );

  let enqueued = 0;
  let skipped = 0;

  for (const issue of issues) {
    if (hasSkipLabel(issue.labels, config.skipLabels)) {
      skipped += 1;
      continue;
    }

    const key = `${issue.projectId}:${issue.issueIid}`;
    if (!includeSucceeded && doneKeys.has(key)) {
      skipped += 1;
      continue;
    }

    const result = await jobQueue.enqueue(issue, { source });
    if (result.enqueued) enqueued += 1;
    else skipped += 1;
  }

  logger.info("Scan done", { found: issues.length, enqueued, skipped, source });
  return { found: issues.length, enqueued, skipped };
}
