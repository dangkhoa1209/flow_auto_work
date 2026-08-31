/**
 * SCM facade — Workbench issue/PR/label ops for GitLab or GitHub.
 * BA helpers stay on plugins/gitlab directly.
 */
import {
  applyIssueActions as glApplyIssueActions,
  commentOnIssue as glCommentOnIssue,
  collectRelatedIssuesUi as glCollectRelatedIssuesUi,
  createIssue as glCreateIssue,
  createMergeRequest as glCreateMergeRequest,
  fetchIssueAsJob as glFetchIssueAsJob,
  findOpenMergeRequest as glFindOpenMergeRequest,
  getIssueUiDetail as glGetIssueUiDetail,
  getProjectDefaultBranch as glGetProjectDefaultBranch,
  listAssignedOpenIssues as glListAssignedOpenIssues,
  listProjectLabels as glListProjectLabels,
  listProjectMembers as glListProjectMembers,
  listProjectMilestones as glListProjectMilestones,
  acceptMergeRequest as glAcceptMergeRequest,
  waitUntilMrReady as glWaitUntilMrReady,
  type IssueDetailUi,
  type RelatedIssueUi,
} from "../gitlab/client.js";
import {
  applyGithubIssueActions,
  commentOnGithubIssue,
  createGithubIssue,
  createGithubPullRequest,
  fetchGithubIssueAsJob,
  fetchGithubRepo,
  findOpenGithubPullRequest,
  getGithubIssueUiDetail,
  listAssignedOpenGithubIssues,
  listGithubCollaborators,
  listGithubMilestones,
  listGithubProjectLabels,
  mergeGithubPullRequest,
} from "../github/client.js";
import {
  getRuntimeContext,
  requireRuntimeContext,
} from "../../workspace/runtime.js";
import { normalizeGitProvider, type GitProvider } from "../../workspace/types.js";

export type { IssueDetailUi, RelatedIssueUi };

export function currentGitProvider(): GitProvider {
  const rt = getRuntimeContext();
  return normalizeGitProvider(rt?.gitProvider);
}

export function isGithubProvider(): boolean {
  return currentGitProvider() === "github";
}

export async function listAssignedOpenIssues() {
  if (isGithubProvider()) return listAssignedOpenGithubIssues();
  return glListAssignedOpenIssues();
}

export async function fetchIssueAsJob(
  issueIid: number,
  projectIdOrPath?: number | string,
) {
  if (isGithubProvider()) {
    const path =
      typeof projectIdOrPath === "string" && projectIdOrPath.includes("/")
        ? projectIdOrPath
        : undefined;
    return fetchGithubIssueAsJob(issueIid, path);
  }
  return glFetchIssueAsJob(issueIid, projectIdOrPath);
}

export async function getIssueUiDetail(
  issueIid: number,
  projectIdOrPath?: number | string,
) {
  if (isGithubProvider()) return getGithubIssueUiDetail(issueIid);
  return glGetIssueUiDetail(issueIid, projectIdOrPath);
}

export async function commentOnIssue(
  projectIdOrPath: number | string,
  issueIid: number,
  body: string,
) {
  if (isGithubProvider()) {
    const path =
      typeof projectIdOrPath === "string" && projectIdOrPath.includes("/")
        ? projectIdOrPath
        : undefined;
    return commentOnGithubIssue(issueIid, body, path);
  }
  return glCommentOnIssue(projectIdOrPath, issueIid, body);
}

export async function applyIssueActions(opts: {
  projectId: number | string;
  issueIid: number;
  assignees?: string[];
  labels?: string[];
  removeLabels?: string[];
  labelMode?: "add" | "set";
  comment?: string;
}) {
  if (isGithubProvider()) return applyGithubIssueActions(opts);
  return glApplyIssueActions(opts);
}

export async function listProjectLabels(projectIdOrPath?: number | string) {
  if (isGithubProvider()) {
    const path =
      typeof projectIdOrPath === "string" && projectIdOrPath.includes("/")
        ? projectIdOrPath
        : undefined;
    return listGithubProjectLabels(path);
  }
  return glListProjectLabels(projectIdOrPath);
}

export async function listProjectMilestones(
  projectIdOrPath?: number | string,
  token?: string,
) {
  if (isGithubProvider()) {
    const rt = requireRuntimeContext();
    const path =
      typeof projectIdOrPath === "string" && projectIdOrPath.includes("/")
        ? projectIdOrPath
        : rt.gitlabPath;
    return listGithubMilestones(
      path,
      token || rt.gitlabToken,
      rt.gitlabHost,
    );
  }
  return glListProjectMilestones(projectIdOrPath, token);
}

export async function listProjectMembers() {
  if (isGithubProvider()) return listGithubCollaborators();
  return glListProjectMembers();
}

export async function getProjectDefaultBranch(
  projectIdOrPath: number | string,
): Promise<string> {
  if (isGithubProvider()) {
    const rt = requireRuntimeContext();
    const path =
      typeof projectIdOrPath === "string" && projectIdOrPath.includes("/")
        ? projectIdOrPath
        : rt.gitlabPath;
    const meta = await fetchGithubRepo(path, rt.gitlabToken, rt.gitlabHost);
    return meta.defaultBranch || "main";
  }
  return glGetProjectDefaultBranch(projectIdOrPath);
}

export async function collectRelatedIssuesUi(
  projectId: number,
  issueIid: number,
  opts?: Parameters<typeof glCollectRelatedIssuesUi>[2],
): Promise<RelatedIssueUi[]> {
  if (isGithubProvider()) return [];
  return glCollectRelatedIssuesUi(projectId, issueIid, opts);
}

export async function createIssue(opts: {
  title: string;
  description?: string;
  labels?: string[];
  assignees?: string[];
  projectIdOrPath?: number | string;
}) {
  if (isGithubProvider()) {
    const created = await createGithubIssue(opts);
    const rt = requireRuntimeContext();
    return {
      id: created.issueId,
      iid: created.issueIid,
      title: created.title,
      description: opts.description || "",
      webUrl: created.url,
      labels: opts.labels || [],
      projectId: rt.gitlabProjectId || 0,
      assignees: created.assignees,
    };
  }
  return glCreateIssue(opts);
}

export async function createMergeRequest(opts: {
  projectId: number | string;
  sourceBranch: string;
  targetBranch: string;
  title: string;
  description: string;
  issueIid?: number;
  assigneeUsernames?: string[];
  reviewerUsernames?: string[];
}): Promise<{ webUrl: string; iid: number }> {
  if (isGithubProvider()) {
    const pr = await createGithubPullRequest({
      sourceBranch: opts.sourceBranch,
      targetBranch: opts.targetBranch,
      title: opts.title,
      description: opts.description,
    });
    return { webUrl: pr.webUrl, iid: pr.iid };
  }
  return glCreateMergeRequest(opts);
}

export async function findOpenMergeRequest(opts: {
  projectId: number | string;
  sourceBranch: string;
  targetBranch: string;
}): Promise<{ webUrl: string; iid: number; mergeStatus?: string } | null> {
  if (isGithubProvider()) {
    const pr = await findOpenGithubPullRequest({
      sourceBranch: opts.sourceBranch,
      targetBranch: opts.targetBranch,
    });
    if (!pr) return null;
    return { webUrl: pr.webUrl, iid: pr.iid };
  }
  return glFindOpenMergeRequest(opts);
}

export async function waitUntilMrReady(opts: {
  projectId: number | string;
  mergeRequestIid: number;
  timeoutMs?: number;
  intervalMs?: number;
}) {
  if (isGithubProvider()) {
    return {
      state: "opened",
      merge_status: "can_be_merged",
      detailed_merge_status: "mergeable",
      web_url: undefined as string | undefined,
      merge_commit_sha: null as string | null,
      has_conflicts: false,
      merge_error: null as string | null,
    };
  }
  return glWaitUntilMrReady(opts);
}

export async function acceptMergeRequest(opts: {
  projectId: number | string;
  mergeRequestIid: number;
  mergeCommitMessage?: string;
  shouldRemoveSourceBranch?: boolean;
  sha?: string;
}): Promise<{
  state: string;
  mergeCommitSha: string | null;
  webUrl?: string;
  alreadyMerged?: boolean;
}> {
  if (isGithubProvider()) {
    const merged = await mergeGithubPullRequest({
      pullNumber: opts.mergeRequestIid,
    });
    return {
      state: "merged",
      mergeCommitSha: merged.sha ?? null,
    };
  }
  return glAcceptMergeRequest(opts);
}
