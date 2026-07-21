import type { AppConfig } from "../config.js";
import type { IssueJob } from "../types.js";

type GitlabUser = {
  id?: number;
  username?: string;
  name?: string;
};

type GitlabLabel = {
  title?: string;
  name?: string;
};

export type GitlabIssueHookPayload = {
  object_kind?: string;
  event_type?: string;
  project?: {
    id?: number;
    path_with_namespace?: string;
  };
  object_attributes?: {
    id?: number;
    iid?: number;
    title?: string;
    description?: string | null;
    state?: string;
    action?: string;
    url?: string;
    assignee_id?: number | null;
  };
  assignees?: GitlabUser[];
  labels?: GitlabLabel[];
  changes?: {
    assignees?: unknown;
    description?: unknown;
    title?: unknown;
    labels?: unknown;
  };
};

export type FilterResult =
  | { accept: true; job: IssueJob }
  | { accept: false; reason: string };

function labelTitles(labels: GitlabLabel[] | undefined): string[] {
  return (labels ?? [])
    .map((l) => (l.title ?? l.name ?? "").trim())
    .filter(Boolean);
}

function isAssignedToMe(
  payload: GitlabIssueHookPayload,
  config: AppConfig,
): boolean {
  const username = config.GITLAB_ASSIGNEE_USERNAME.toLowerCase();
  const assignees = payload.assignees ?? [];
  if (
    assignees.some((a) => (a.username ?? "").toLowerCase() === username)
  ) {
    return true;
  }
  if (config.GITLAB_ASSIGNEE_ID) {
    const id = Number(config.GITLAB_ASSIGNEE_ID);
    if (
      !Number.isNaN(id) &&
      (assignees.some((a) => a.id === id) ||
        payload.object_attributes?.assignee_id === id)
    ) {
      return true;
    }
  }
  return false;
}

export function filterIssueHook(
  eventHeader: string | undefined,
  payload: GitlabIssueHookPayload,
  config: AppConfig,
): FilterResult {
  if (eventHeader && eventHeader !== "Issue Hook") {
    return { accept: false, reason: `Unsupported event: ${eventHeader}` };
  }

  if (payload.object_kind && payload.object_kind !== "issue") {
    return {
      accept: false,
      reason: `Unsupported object_kind: ${payload.object_kind}`,
    };
  }

  const projectPath = payload.project?.path_with_namespace ?? "";
  if (projectPath !== config.ALLOWED_PROJECT_PATH) {
    return {
      accept: false,
      reason: `Project mismatch: ${projectPath || "(empty)"}`,
    };
  }

  const attrs = payload.object_attributes;
  if (!attrs?.iid || !attrs?.id || !payload.project?.id) {
    return { accept: false, reason: "Missing issue/project identifiers" };
  }

  const action = (attrs.action ?? "").toLowerCase();
  if (!["open", "reopen", "update"].includes(action)) {
    return { accept: false, reason: `Ignored action: ${action || "(none)"}` };
  }

  if (!isAssignedToMe(payload, config)) {
    return { accept: false, reason: "Not assigned to configured user" };
  }

  const labels = labelTitles(payload.labels);
  const lower = labels.map((l) => l.toLowerCase());
  for (const skip of config.skipLabels) {
    if (lower.includes(skip)) {
      return { accept: false, reason: `Skip label present: ${skip}` };
    }
  }

  // For updates without assignee/description/title/label changes, skip noise
  if (action === "update" && payload.changes) {
    const meaningful =
      "assignees" in payload.changes ||
      "description" in payload.changes ||
      "title" in payload.changes ||
      "labels" in payload.changes;
    if (!meaningful) {
      return { accept: false, reason: "Update without meaningful changes" };
    }
  }

  return {
    accept: true,
    job: {
      projectId: payload.project.id,
      projectPath,
      issueIid: attrs.iid,
      issueId: attrs.id,
      title: attrs.title ?? `(issue #${attrs.iid})`,
      description: attrs.description ?? "",
      labels,
      url: attrs.url ?? "",
      action,
    },
  };
}
