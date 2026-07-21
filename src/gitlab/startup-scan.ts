import { getConfig } from "../config.js";
import { listJobs } from "../job-store.js";
import { logger } from "../logger.js";
import { jobQueue } from "../queue.js";
import { listAssignedOpenIssues } from "./client.js";

function hasSkipLabel(labels: string[], skipLabels: string[]): boolean {
  const lower = labels.map((l) => l.toLowerCase());
  return skipLabels.some((s) => lower.includes(s));
}

/**
 * On process start: pull open issues already assigned to you and enqueue them.
 * Skips skip-labels, active jobs, and issues that already succeeded once
 * (so a restart does not re-do finished work).
 */
export async function scanExistingAssignedIssues(): Promise<{
  found: number;
  enqueued: number;
  skipped: number;
}> {
  const config = getConfig();
  if (!config.STARTUP_SCAN) {
    logger.info("Startup scan disabled (STARTUP_SCAN=false)");
    return { found: 0, enqueued: 0, skipped: 0 };
  }

  logger.info("Startup scan: fetching assigned open issues", {
    project: config.ALLOWED_PROJECT_PATH,
    assignee: config.GITLAB_ASSIGNEE_USERNAME,
  });

  const issues = await listAssignedOpenIssues();
  const jobs = await listJobs();
  const succeededKeys = new Set(
    jobs
      .filter((j) => j.status === "succeeded")
      .map((j) => `${j.issue.projectId}:${j.issue.issueIid}`),
  );

  let enqueued = 0;
  let skipped = 0;

  for (const issue of issues) {
    if (hasSkipLabel(issue.labels, config.skipLabels)) {
      logger.info("Startup scan skip: label", {
        iid: issue.issueIid,
        labels: issue.labels,
      });
      skipped += 1;
      continue;
    }

    const key = `${issue.projectId}:${issue.issueIid}`;
    if (!config.STARTUP_SCAN_INCLUDE_SUCCEEDED && succeededKeys.has(key)) {
      logger.info("Startup scan skip: already succeeded", {
        iid: issue.issueIid,
      });
      skipped += 1;
      continue;
    }

    const result = jobQueue.enqueue(issue);
    if (result.enqueued) {
      enqueued += 1;
    } else {
      logger.info("Startup scan skip: queue", {
        iid: issue.issueIid,
        reason: result.reason,
      });
      skipped += 1;
    }
  }

  logger.info("Startup scan done", {
    found: issues.length,
    enqueued,
    skipped,
  });
  return { found: issues.length, enqueued, skipped };
}
