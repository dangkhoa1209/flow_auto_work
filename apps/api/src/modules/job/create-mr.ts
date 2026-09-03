/**
 * Create open MR only (no accept) + Issue Ready to Release label (no issue comment).
 */
import { getConfig } from "../../config.js";
import { saveJob } from "../../job-store.js";
import { logger } from "../../logger.js";
import { hasUncommittedChanges } from "../../plugins/git/prep.js";
import {
  applyIssueActions,
  createMergeRequest,
  findOpenMergeRequest,
  getProjectDefaultBranch,
} from "../../plugins/scm/index.js";
import { AppError } from "../../utils/AppError.js";
import { resolveGitlabProjectPath } from "../../workspace/creds.js";
import { getRuntimeContext } from "../../workspace/runtime.js";
import { requireJobDoc } from "./lifecycle.js";
import {
  buildTaskChangeText,
  extractDoneSummaryLine,
  listJobWorkHistory,
  listTaskChangedFiles,
  listTaskCommitSubjects,
} from "./taskChangeSummary.js";

const READY_LABEL = "Ready to Release";

function buildMrTitle(opts: {
  issueIid: number;
  issueTitle: string;
  commitSubject?: string;
}): string {
  const iid = opts.issueIid;
  const fromCommit = opts.commitSubject?.trim();
  if (fromCommit && /^(\w+)(\(.+\))?:/.test(fromCommit)) {
    return fromCommit;
  }
  const summary = (
    fromCommit ||
    opts.issueTitle ||
    "Work branch changes"
  )
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 72);
  if (iid > 0) {
    return `feat: [#${iid}] ${summary.replace(/^feat\s*#?\d+\s*/i, "")}`;
  }
  return `feat: ${summary}`;
}

function buildMrBody(opts: {
  issueIid: number;
  issueTitle: string;
  changeText?: string;
  files?: string[];
}): string {
  const iid = opts.issueIid;
  const purpose =
    opts.changeText?.trim() ||
    (opts.issueTitle
      ? `Hoàn thành thay đổi cho issue: ${opts.issueTitle}.`
      : "Hoàn thành thay đổi trên nhánh work.");
  const fileBullets =
    opts.files && opts.files.length
      ? opts.files
          .slice(0, 40)
          .map((p) => `* \`${p}\``)
          .join("\n")
      : "* Cập nhật code theo scope issue";

  const issueLine = iid > 0 ? `\n\n(Issue: #${iid})` : "";

  return [
    `# **Mục đích**`,
    ``,
    `${purpose}${issueLine}`,
    ``,
    `# **Thay đổi chính**`,
    ``,
    fileBullets,
    ``,
    `# **Checklist**`,
    ``,
    `* [x] Code đã commit trên nhánh work`,
    `* [x] MR sẵn sàng review`,
    iid > 0 ? `* [x] Issue #${iid} gắn Ready to Release` : null,
  ]
    .filter((l) => l !== null)
    .join("\n");
}

export async function createJobMergeRequest(
  jobId: string,
  input: { targetBranch?: string } = {},
) {
  const job = await requireJobDoc(jobId);
  if (job.status !== "awaiting_handoff" && job.status !== "succeeded") {
    throw new AppError(
      "Create MR only for awaiting_handoff or succeeded jobs",
      409,
    );
  }

  const source = (job.branch || job.workBranch || "").trim();
  if (!source) {
    throw new AppError("Job has no work branch for MR", 400);
  }

  const rt = getRuntimeContext();
  const repoPath = rt?.repoPath?.trim();
  if (repoPath && (await hasUncommittedChanges(repoPath))) {
    throw new AppError(
      "Uncommitted changes present — Commit before Create MR",
      409,
    );
  }
  if (job.hasPendingChanges) {
    throw new AppError(
      "Pending changes not committed — Commit before Create MR",
      409,
    );
  }

  const projectIdOrPath: number | string =
    rt?.gitlabProjectId ?? job.issue?.projectId ?? resolveGitlabProjectPath();

  let target =
    input.targetBranch?.trim() ||
    job.baseBranch?.trim() ||
    rt?.baseBranch?.trim() ||
    "";
  if (!target) {
    try {
      target = await getProjectDefaultBranch(projectIdOrPath);
    } catch {
      /* fall through */
    }
  }
  if (!target) {
    throw new AppError(
      "Could not determine target branch (base/default)",
      400,
    );
  }

  const existing = await findOpenMergeRequest({
    projectId: projectIdOrPath,
    sourceBranch: source,
    targetBranch: target,
  });
  if (existing) {
    job.mrUrl = existing.webUrl;
    job.mrIid = existing.iid;
    await saveJob(job, { source: "create_mr" });
    return {
      ok: true,
      created: false,
      mrUrl: existing.webUrl,
      mrIid: existing.iid,
      job,
    };
  }

  const iid = job.issue?.issueIid ?? 0;

  // Full task range (base...work), not only the tip / last agent run.
  let files: string[] = [];
  let commitSubjects: string[] = [];
  const workHistory = await listJobWorkHistory(job.id);
  if (repoPath) {
    files = await listTaskChangedFiles({
      repoPath,
      sourceBranch: source,
      targetBranch: target,
    });
    if (!workHistory.length && !extractDoneSummaryLine(job.summary)) {
      commitSubjects = await listTaskCommitSubjects({
        repoPath,
        sourceBranch: source,
        targetBranch: target,
        commitShas: job.commitShas,
      });
    }
  }

  const changeText = buildTaskChangeText({
    issueTitle: job.issue?.title || "",
    jobSummary: job.summary,
    workHistory,
    fallback: "Hoàn thành thay đổi trên nhánh work.",
  });

  const title = buildMrTitle({
    issueIid: iid,
    issueTitle: job.issue?.title || source,
    commitSubject:
      extractDoneSummaryLine(job.summary) ||
      workHistory[workHistory.length - 1] ||
      commitSubjects[commitSubjects.length - 1] ||
      job.issue?.title ||
      source,
  });

  const description = buildMrBody({
    issueIid: iid,
    issueTitle: job.issue?.title || "",
    changeText,
    files,
  });

  const config = getConfig();
  const assignees =
    config.mrAssigneeUsernames.length > 0
      ? config.mrAssigneeUsernames
      : ["anhvh4"];
  const reviewers =
    config.mrReviewerUsernames.length > 0
      ? config.mrReviewerUsernames
      : assignees;

  const mr = await createMergeRequest({
    projectId: projectIdOrPath,
    sourceBranch: source,
    targetBranch: target,
    title,
    description,
    issueIid: iid > 0 ? iid : undefined,
    assigneeUsernames: assignees,
    reviewerUsernames: reviewers,
  });

  job.mrUrl = mr.webUrl;
  job.mrIid = mr.iid;
  await saveJob(job, { source: "create_mr" });

  if (iid > 0) {
    try {
      await applyIssueActions({
        projectId: job.issue.projectId,
        issueIid: iid,
        labels: [READY_LABEL],
        labelMode: "add",
      });
    } catch (err) {
      logger.warn("Create MR ok but Issue label failed", {
        jobId: job.id,
        iid,
        err: String(err),
      });
    }
  }

  logger.info("Created open MR", {
    jobId: job.id,
    mrIid: mr.iid,
    source,
    target,
  });

  return {
    ok: true,
    created: true,
    mrUrl: mr.webUrl,
    mrIid: mr.iid,
    job,
  };
}
