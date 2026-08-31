import { getConfig } from "../../config.js";
import {
  applyIssueActions,
  getIssueUiDetail,
  listAssignedOpenIssues,
} from "../../plugins/scm/index.js";
import { resolveGitlabProjectPath } from "../../workspace/creds.js";
import { AppError } from "../../utils/AppError.js";

export async function listTasks() {
  const config = getConfig();
  const issues = await listAssignedOpenIssues();
  const tasks = issues.map((issue) => {
    const skip = issue.labels.some((l) =>
      config.skipLabels.includes(l.toLowerCase()),
    );
    return { ...issue, skip };
  });
  return { tasks, count: tasks.length };
}

export async function getTaskDetail(iid: number) {
  if (!Number.isFinite(iid) || iid <= 0) {
    throw new AppError("invalid iid", 400);
  }
  try {
    const detail = await getIssueUiDetail(iid);
    return { detail };
  } catch (err) {
    throw new AppError(
      err instanceof Error ? err.message : String(err),
      404,
    );
  }
}

export type UpdateTasksInput = {
  issueIids?: number[];
  assignees?: string[];
  labels?: string[];
  removeLabels?: string[];
  labelMode?: "add" | "set";
  comment?: string;
};

export async function updateTasks(body: UpdateTasksInput) {
  const issueIids = (body.issueIids ?? [])
    .map((n) => Number(n))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (issueIids.length === 0) {
    throw new AppError("issueIids required", 400);
  }
  const assignees = (body.assignees ?? [])
    .map((s) => String(s).trim())
    .filter(Boolean);
  const labels = (body.labels ?? [])
    .map((s) => String(s).trim())
    .filter(Boolean);
  const removeLabels = (body.removeLabels ?? [])
    .map((s) => String(s).trim())
    .filter(Boolean);
  const comment = body.comment?.trim();
  if (
    !assignees.length &&
    !labels.length &&
    !removeLabels.length &&
    !comment &&
    body.labelMode !== "set"
  ) {
    throw new AppError(
      "Need at least assignees, labels, removeLabels, or comment",
      400,
    );
  }

  const assigned = await listAssignedOpenIssues();
  const byIid = new Map(assigned.map((i) => [i.issueIid, i]));
  const results: Array<{ issueIid: number; ok: boolean; error?: string }> = [];

  for (const iid of issueIids) {
    try {
      const issue = byIid.get(iid);
      await applyIssueActions({
        projectId: issue?.projectId ?? resolveGitlabProjectPath(),
        issueIid: iid,
        assignees,
        labels,
        removeLabels,
        labelMode: body.labelMode ?? "add",
        comment,
      });
      results.push({ issueIid: iid, ok: true });
    } catch (err) {
      results.push({
        issueIid: iid,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    ok: results.every((r) => r.ok),
    results,
  };
}
