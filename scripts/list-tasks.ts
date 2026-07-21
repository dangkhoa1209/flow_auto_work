/**
 * List (and optionally enqueue) open issues assigned to you.
 *
 *   npm run list-tasks          # print only
 *   npm run scan                # print + enqueue
 *
 * Needs in .env (real values, not placeholders):
 *   GITLAB_TOKEN, GITLAB_ASSIGNEE_USERNAME, ALLOWED_PROJECT_PATH
 */
import { getGitlabScanConfig } from "../src/gitlab/scan-config.js";
import { listAssignedOpenIssues } from "../src/gitlab/client.js";
import { scanExistingAssignedIssues } from "../src/gitlab/startup-scan.js";

/** Allow listAssignedOpenIssues (uses getConfig) without full Cursor/Teams setup. */
function ensureFullConfigForGitlabApi() {
  if (
    !process.env.CURSOR_API_KEY ||
    process.env.CURSOR_API_KEY.includes("...")
  ) {
    process.env.CURSOR_API_KEY = "list-tasks-placeholder-ok";
  }
  if (
    !process.env.GITLAB_WEBHOOK_SECRET ||
    process.env.GITLAB_WEBHOOK_SECRET === "change-me"
  ) {
    process.env.GITLAB_WEBHOOK_SECRET = "list-tasks-placeholder-ok";
  }
  process.env.AIHR_REPO_PATH ??=
    "/Users/dangkhoa/Developer/Work/Jobtest/aihr_v3";
  process.env.ALLOWED_PROJECT_PATH ??= "kiemnv/aihr_v3";
}

async function listOnly() {
  const scanCfg = getGitlabScanConfig();
  ensureFullConfigForGitlabApi();

  // Lazy import after env patched so getConfig cache sees real GITLAB_* + soft dummies
  const { getConfig } = await import("../src/config.js");
  getConfig();

  console.log("Scanning GitLab…");
  console.log(`  project : ${scanCfg.ALLOWED_PROJECT_PATH}`);
  console.log(`  assignee: ${scanCfg.GITLAB_ASSIGNEE_USERNAME}`);
  console.log("");

  const issues = await listAssignedOpenIssues();
  if (issues.length === 0) {
    console.log("No open issues assigned to you in this project.");
    console.log("Check:");
    console.log("  - GITLAB_ASSIGNEE_USERNAME matches gitlab.com/<username>");
    console.log("  - Issues are opened + assigned to you");
    console.log("  - Token has `api` scope and can read the project");
    return;
  }

  console.log(`Found ${issues.length} open assigned issue(s):\n`);
  for (const issue of issues) {
    const skip = issue.labels.some((l) =>
      scanCfg.skipLabels.includes(l.toLowerCase()),
    );
    const mark = skip ? "SKIP" : "OK  ";
    console.log(
      `[${mark}] #${issue.issueIid}  ${issue.title}\n` +
        `         ${issue.url}\n` +
        `         labels: ${issue.labels.join(", ") || "(none)"}\n`,
    );
  }
}

async function scanAndEnqueue() {
  getGitlabScanConfig();
  ensureFullConfigForGitlabApi();
  const { getConfig } = await import("../src/config.js");
  getConfig();
  const result = await scanExistingAssignedIssues();
  console.log(
    `\nDone. found=${result.found} enqueued=${result.enqueued} skipped=${result.skipped}`,
  );
  console.log(
    "Keep `npm run dev` running so enqueued jobs actually execute (needs real CURSOR_API_KEY).",
  );
}

const mode = process.argv[2] ?? "list";

try {
  if (mode === "enqueue" || mode === "scan") {
    await scanAndEnqueue();
  } else {
    await listOnly();
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
