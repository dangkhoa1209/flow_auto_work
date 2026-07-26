/**
 * Review surface: commits, revert, unified diff, inline file edit, approval.
 */
import { getReviewDiff, listJobCommits } from "../../plugins/git/diff.js";
import {
  extractPathsFromUnifiedDiff,
  readRepoFile,
  writeRepoFile,
} from "../../plugins/git/files.js";
import { saveJob } from "../../job-store.js";
import { logger } from "../../logger.js";
import {
  isAwaitingDiffApproval,
  submitDiffApproval,
} from "../../plugins/review/diff-wait.js";
import { getRuntimeContext } from "../../workspace/runtime.js";
import { AppError } from "../../utils/AppError.js";
import { requireJobDoc } from "./lifecycle.js";

export async function getJobCommits(jobId: string) {
  const job = await requireJobDoc(jobId);
  const rt = getRuntimeContext();
  try {
    const commits = await listJobCommits({
      issueIid: job.issue.issueIid > 0 ? job.issue.issueIid : undefined,
      branch: job.branch || job.workBranch,
      baseBranch:
        job.baseBranch || rt?.baseBranch || job.mergeTarget || undefined,
      commitShas: job.commitShas,
      commitSha: job.commitSha,
    });
    return {
      jobId: job.id,
      branch: job.branch || job.workBranch || null,
      commitSha: job.commitSha || null,
      commits,
    };
  } catch (err) {
    throw new AppError(err instanceof Error ? err.message : String(err), 400);
  }
}

export async function revertJobCommit(
  jobId: string,
  sha: string | undefined,
  input: { message?: string },
) {
  const job = await requireJobDoc(jobId);
  const commitSha = sha?.trim();
  if (!commitSha) throw new AppError("sha required", 400);
  const branch = (job.branch || job.workBranch || "").trim();
  if (!branch) {
    throw new AppError("Job has no branch to revert", 400);
  }
  const rt = getRuntimeContext();
  const repoPath = rt?.repoPath;
  if (!repoPath) {
    throw new AppError("No local repo path — clone the project first", 400);
  }
  const projectIdOrPath =
    rt?.gitlabProjectId ?? rt?.gitlabPath ?? job.issue.projectId;
  try {
    const { revertCommitViaGitlab } = await import("../../plugins/git/revert.js");
    const result = await revertCommitViaGitlab({
      repoPath,
      branch,
      sha: commitSha,
      projectIdOrPath,
      token: rt?.gitlabToken,
      message: input.message,
    });
    job.commitSha = result.commitSha;
    const prev = Array.isArray(job.commitShas) ? job.commitShas : [];
    if (!prev.includes(result.commitSha)) {
      job.commitShas = [...prev, result.commitSha].slice(-20);
    }
    await saveJob(job, { source: "revert" });
    return {
      ok: true,
      job,
      commitSha: result.commitSha,
      message: result.message,
    };
  } catch (err) {
    logger.error("Revert commit failed", {
      jobId: job.id,
      sha: commitSha,
      err: String(err),
    });
    throw new AppError(err instanceof Error ? err.message : String(err), 400);
  }
}

export async function getJobDiff(jobId: string, singleCommit?: string) {
  const job = await requireJobDoc(jobId);
  const rt = getRuntimeContext();
  try {
    const diff = await getReviewDiff({
      issueIid: job.issue.issueIid > 0 ? job.issue.issueIid : undefined,
      branch: job.branch || job.workBranch,
      baseBranch:
        job.baseBranch || rt?.baseBranch || job.mergeTarget || undefined,
      commitSha: job.commitSha,
      singleCommit,
    });
    const text = [diff.rangeDiff, diff.staged, diff.unstaged]
      .filter(Boolean)
      .join("\n");
    const paths =
      diff.files?.length > 0
        ? diff.files.map((f) => f.path)
        : extractPathsFromUnifiedDiff(text);
    return {
      jobId: job.id,
      issueIid: job.issue.issueIid,
      status: job.status,
      branch: job.branch || job.workBranch || null,
      commitSha: singleCommit || job.commitSha || null,
      diff,
      paths,
      files: diff.files,
      awaitingDiffApproval:
        job.status === "awaiting_diff_approval" ||
        isAwaitingDiffApproval(job.id),
    };
  } catch (err) {
    throw new AppError(err instanceof Error ? err.message : String(err), 400);
  }
}

export async function approveJobDiff(
  jobId: string,
  input: { action?: "approve" | "reject"; message?: string },
) {
  await requireJobDoc(jobId);
  const action = input.action === "reject" ? "reject" : "approve";
  const ok = submitDiffApproval(
    jobId,
    action === "approve"
      ? { action: "approve" }
      : { action: "reject", message: input.message },
  );
  if (!ok) {
    throw new AppError("Job is not awaiting diff approval", 409);
  }
  return { ok: true, action };
}

export async function readJobFile(jobId: string, filePath?: string) {
  await requireJobDoc(jobId);
  if (!filePath) throw new AppError("path required", 400);
  try {
    const content = await readRepoFile(filePath);
    return { path: filePath, content };
  } catch (err) {
    throw new AppError(err instanceof Error ? err.message : String(err), 400);
  }
}

export async function writeJobFile(
  jobId: string,
  input: { path?: string; content?: string },
) {
  const job = await requireJobDoc(jobId);
  if (
    job.status !== "awaiting_diff_approval" &&
    !isAwaitingDiffApproval(job.id)
  ) {
    throw new AppError("Inline edit only while awaiting_diff_approval", 409);
  }
  if (!input.path || input.content === undefined) {
    throw new AppError("path and content required", 400);
  }
  try {
    await writeRepoFile(input.path, input.content);
    return { ok: true, path: input.path };
  } catch (err) {
    throw new AppError(err instanceof Error ? err.message : String(err), 400);
  }
}
