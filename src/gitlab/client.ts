import { getConfig } from "../config.js";
import { logger } from "../logger.js";
import {
  resolveAssigneeUsername,
  resolveGitlabProjectPath,
  resolveGitlabToken,
} from "../workspace/creds.js";

async function gitlabFetch(
  method: string,
  apiPath: string,
  body?: unknown,
  tokenOverride?: string,
): Promise<Response> {
  const config = getConfig();
  const url = `${config.GITLAB_BASE_URL.replace(/\/$/, "")}/api/v4${apiPath}`;
  const res = await fetch(url, {
    method,
    headers: {
      "PRIVATE-TOKEN": tokenOverride ?? resolveGitlabToken(),
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res;
}

/** Verify PAT and return GitLab user profile. */
export async function verifyGitlabTokenUser(token: string): Promise<{
  id: number;
  username: string;
  name?: string;
}> {
  const res = await gitlabFetch("GET", "/user", undefined, token);
  if (!res.ok) {
    throw new Error(
      `GitLab token invalid (${res.status}): ${await res.text()}`,
    );
  }
  const data = (await res.json()) as {
    id: number;
    username: string;
    name?: string;
  };
  if (!data.username) throw new Error("GitLab /user missing username");
  return data;
}

/** Resolve project id + path with a given token. */
export async function fetchGitlabProject(
  gitlabPath: string,
  token?: string,
): Promise<{ id: number; pathWithNamespace: string; name: string }> {
  const project = encodeURIComponent(gitlabPath.trim());
  const res = await gitlabFetch(
    "GET",
    `/projects/${project}`,
    undefined,
    token,
  );
  if (!res.ok) {
    throw new Error(
      `GitLab project ${gitlabPath} failed (${res.status}): ${await res.text()}`,
    );
  }
  const data = (await res.json()) as {
    id: number;
    path_with_namespace: string;
    name: string;
  };
  return {
    id: data.id,
    pathWithNamespace: data.path_with_namespace,
    name: data.name,
  };
}

/** Projects the token owner is a member of. */
export async function listMyGitlabProjects(token: string): Promise<
  Array<{
    id: number;
    pathWithNamespace: string;
    name: string;
    defaultBranch?: string;
  }>
> {
  const out: Array<{
    id: number;
    pathWithNamespace: string;
    name: string;
    defaultBranch?: string;
  }> = [];
  let page = 1;
  while (page <= 10) {
    const qs = new URLSearchParams({
      membership: "true",
      simple: "true",
      per_page: "100",
      page: String(page),
      order_by: "last_activity_at",
      sort: "desc",
    });
    const res = await gitlabFetch(
      "GET",
      `/projects?${qs.toString()}`,
      undefined,
      token,
    );
    if (!res.ok) {
      throw new Error(
        `GitLab list projects failed (${res.status}): ${await res.text()}`,
      );
    }
    const batch = (await res.json()) as Array<{
      id: number;
      path_with_namespace: string;
      name: string;
      default_branch?: string;
    }>;
    if (!batch.length) break;
    for (const p of batch) {
      out.push({
        id: p.id,
        pathWithNamespace: p.path_with_namespace,
        name: p.name,
        defaultBranch: p.default_branch,
      });
    }
    if (batch.length < 100) break;
    page += 1;
  }
  return out;
}

/** Remote branches for a project (GitLab API). */
export async function listGitlabBranches(
  gitlabPathOrId: string | number,
  token: string,
): Promise<Array<{ name: string; default?: boolean; protected?: boolean }>> {
  const project = encodeURIComponent(String(gitlabPathOrId));
  const out: Array<{ name: string; default?: boolean; protected?: boolean }> =
    [];
  let page = 1;
  while (page <= 20) {
    const qs = new URLSearchParams({
      per_page: "100",
      page: String(page),
    });
    const res = await gitlabFetch(
      "GET",
      `/projects/${project}/repository/branches?${qs.toString()}`,
      undefined,
      token,
    );
    if (!res.ok) {
      throw new Error(
        `GitLab list branches failed (${res.status}): ${await res.text()}`,
      );
    }
    const batch = (await res.json()) as Array<{
      name: string;
      default?: boolean;
      protected?: boolean;
    }>;
    if (!batch.length) break;
    out.push(
      ...batch.map((b) => ({
        name: b.name,
        default: b.default,
        protected: b.protected,
      })),
    );
    if (batch.length < 100) break;
    page += 1;
  }
  return out;
}

export async function commentOnIssue(
  projectId: number | string,
  issueIid: number,
  body: string,
): Promise<void> {
  const project =
    typeof projectId === "string" ? encodeURIComponent(projectId) : projectId;
  const res = await gitlabFetch(
    "POST",
    `/projects/${project}/issues/${issueIid}/notes`,
    { body },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitLab comment failed (${res.status}): ${text}`);
  }
  logger.info("Commented on issue", { projectId, issueIid });
}

export async function createMergeRequest(opts: {
  projectId: number;
  sourceBranch: string;
  targetBranch: string;
  title: string;
  description: string;
  issueIid: number;
}): Promise<{ webUrl: string; iid: number }> {
  const config = getConfig();
  const payload: Record<string, unknown> = {
    source_branch: opts.sourceBranch,
    target_branch: opts.targetBranch,
    title: opts.title,
    description: opts.description,
    remove_source_branch: false,
  };

  const res = await gitlabFetch(
    "POST",
    `/projects/${opts.projectId}/merge_requests`,
    payload,
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitLab create MR failed (${res.status}): ${text}`);
  }
  const data = (await res.json()) as { web_url: string; iid: number };

  if (config.mrReviewerUsernames.length > 0) {
    try {
      await gitlabFetch(
        "PUT",
        `/projects/${opts.projectId}/merge_requests/${data.iid}`,
        { reviewer_ids: await resolveUserIds(config.mrReviewerUsernames) },
      );
    } catch (err) {
      logger.warn("Failed to set MR reviewers", { err: String(err) });
    }
  }

  return { webUrl: data.web_url, iid: data.iid };
}

async function resolveUserIds(usernames: string[]): Promise<number[]> {
  const ids: number[] = [];
  for (const username of usernames) {
    const res = await gitlabFetch(
      "GET",
      `/users?username=${encodeURIComponent(username)}`,
    );
    if (!res.ok) continue;
    const users = (await res.json()) as Array<{ id: number }>;
    if (users[0]?.id) ids.push(users[0].id);
  }
  return ids;
}

export { resolveUserIds };

/**
 * Update a GitLab issue: optional comment + assign + add/remove labels.
 * - labelMode "add" (default): append `labels`
 * - labelMode "set": replace all with `labels`
 * - `removeLabels` always uses GitLab remove_labels
 */
export async function applyIssueActions(opts: {
  /** Numeric project id or URL-encoded-ready path (e.g. group/repo) */
  projectId: number | string;
  issueIid: number;
  assignees?: string[];
  labels?: string[];
  removeLabels?: string[];
  labelMode?: "add" | "set";
  comment?: string;
}): Promise<void> {
  const assignees = (opts.assignees ?? []).map((s) => s.trim()).filter(Boolean);
  const labels = (opts.labels ?? []).map((s) => s.trim()).filter(Boolean);
  const removeLabels = (opts.removeLabels ?? [])
    .map((s) => s.trim())
    .filter(Boolean);
  const comment = opts.comment?.trim();
  const labelMode = opts.labelMode ?? "add";
  const project =
    typeof opts.projectId === "string"
      ? encodeURIComponent(opts.projectId)
      : opts.projectId;

  if (comment) {
    await commentOnIssue(opts.projectId, opts.issueIid, comment);
  }

  if (
    assignees.length === 0 &&
    labels.length === 0 &&
    removeLabels.length === 0 &&
    labelMode !== "set"
  ) {
    return;
  }

  const payload: Record<string, unknown> = {};
  if (assignees.length > 0) {
    const ids = await resolveUserIds(assignees);
    if (ids.length === 0) {
      logger.warn("No GitLab user ids resolved for assignees", { assignees });
    } else {
      payload.assignee_ids = ids;
    }
  }
  if (labels.length > 0 || labelMode === "set") {
    if (labelMode === "set") {
      // empty string clears all labels
      payload.labels = labels.join(",");
    } else {
      payload.add_labels = labels.join(",");
    }
  }
  if (removeLabels.length > 0) {
    payload.remove_labels = removeLabels.join(",");
  }

  if (Object.keys(payload).length === 0) return;

  const res = await gitlabFetch(
    "PUT",
    `/projects/${project}/issues/${opts.issueIid}`,
    payload,
  );
  if (!res.ok) {
    throw new Error(
      `GitLab update issue failed (${res.status}): ${await res.text()}`,
    );
  }
  logger.info("Applied issue actions", {
    issueIid: opts.issueIid,
    assignees,
    labels,
    removeLabels,
    labelMode,
  });
}

/** @deprecated alias — use applyIssueActions */
export async function applyIssueCompletionActions(
  opts: Parameters<typeof applyIssueActions>[0],
): Promise<void> {
  return applyIssueActions(opts);
}

export async function listProjectLabels(
  projectIdOrPath?: number | string,
): Promise<Array<{ name: string; color?: string; description?: string }>> {
  const project = encodeURIComponent(
    String(projectIdOrPath ?? resolveGitlabProjectPath()),
  );
  const labels: Array<{ name: string; color?: string; description?: string }> =
    [];
  let page = 1;
  while (page <= 10) {
    const res = await gitlabFetch(
      "GET",
      `/projects/${project}/labels?per_page=100&page=${page}`,
    );
    if (!res.ok) break;
    const batch = (await res.json()) as Array<{
      name: string;
      color?: string;
      description?: string;
    }>;
    if (!batch.length) break;
    labels.push(
      ...batch.map((l) => ({
        name: l.name,
        color: l.color,
        description: l.description,
      })),
    );
    if (batch.length < 100) break;
    page += 1;
  }
  return labels;
}

export async function listProjectMembers(): Promise<
  Array<{ id: number; username: string; name: string }>
> {
  const project = encodeURIComponent(resolveGitlabProjectPath());
  const members: Array<{ id: number; username: string; name: string }> = [];
  let page = 1;
  while (page <= 10) {
    const res = await gitlabFetch(
      "GET",
      `/projects/${project}/members/all?per_page=100&page=${page}`,
    );
    if (!res.ok) break;
    const batch = (await res.json()) as Array<{
      id: number;
      username: string;
      name: string;
    }>;
    if (!batch.length) break;
    members.push(
      ...batch.map((m) => ({
        id: m.id,
        username: m.username,
        name: m.name,
      })),
    );
    if (batch.length < 100) break;
    page += 1;
  }
  return members;
}

export async function getProjectDefaultBranch(
  projectId: number,
): Promise<string> {
  const res = await gitlabFetch("GET", `/projects/${projectId}`);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitLab project fetch failed (${res.status}): ${text}`);
  }
  const data = (await res.json()) as { default_branch?: string };
  return data.default_branch ?? "main";
}

type GitlabIssueApi = {
  id: number;
  iid: number;
  project_id: number;
  title: string;
  description: string | null;
  web_url: string;
  labels: string[];
  milestone?: {
    id: number;
    title: string;
    state?: string;
  } | null;
};

function mapMilestone(
  raw: GitlabIssueApi["milestone"],
): import("../types.js").IssueMilestone | null {
  if (!raw?.id || !raw.title?.trim()) return null;
  return {
    id: raw.id,
    title: raw.title.trim(),
    state: raw.state,
  };
}

/** Open issues assigned to the current workspace user in the selected project. */
export async function listAssignedOpenIssues(): Promise<
  import("../types.js").IssueJob[]
> {
  const projectPath = resolveGitlabProjectPath();
  const assignee = resolveAssigneeUsername();
  const project = encodeURIComponent(projectPath);
  const issues: GitlabIssueApi[] = [];
  let page = 1;

  while (page <= 20) {
    const qs = new URLSearchParams({
      state: "opened",
      assignee_username: assignee,
      per_page: "100",
      page: String(page),
      order_by: "updated_at",
      sort: "asc",
    });
    const res = await gitlabFetch(
      "GET",
      `/projects/${project}/issues?${qs.toString()}`,
    );
    if (!res.ok) {
      throw new Error(
        `GitLab list issues failed (${res.status}): ${await res.text()}`,
      );
    }
    const batch = (await res.json()) as GitlabIssueApi[];
    if (batch.length === 0) break;
    issues.push(...batch);
    if (batch.length < 100) break;
    page += 1;
  }

  return issues.map((raw) => ({
    projectId: raw.project_id,
    projectPath,
    issueIid: raw.iid,
    issueId: raw.id,
    title: raw.title,
    description: raw.description ?? "",
    labels: raw.labels ?? [],
    url: raw.web_url,
    action: "startup_scan",
    milestone: mapMilestone(raw.milestone),
  }));
}

export type IssueNoteUi = {
  id: number;
  body: string;
  author: string;
  createdAt: string;
  system: boolean;
};

export type RelatedIssueUi = {
  iid: number;
  title: string;
  state: string;
  url: string;
  labels: string[];
  linkType?: string;
  source: "issue_links" | "mention" | "task_list";
};

export type IssueDetailUi = {
  projectId: number;
  issueIid: number;
  title: string;
  description: string;
  state: string;
  url: string;
  labels: string[];
  assignees: Array<{ username: string; name: string }>;
  author?: string;
  createdAt?: string;
  updatedAt?: string;
  milestone?: import("../types.js").IssueMilestone | null;
  taskCompletion?: { count: number; completedCount: number };
  notes: IssueNoteUi[];
  related: RelatedIssueUi[];
};

/**
 * Full issue payload for UI: description, comments, related/child issues.
 */
export async function getIssueUiDetail(
  issueIid: number,
  projectIdOrPath?: number | string,
): Promise<IssueDetailUi> {
  const project = encodeURIComponent(
    String(projectIdOrPath ?? resolveGitlabProjectPath()),
  );

  const issueRes = await gitlabFetch(
    "GET",
    `/projects/${project}/issues/${issueIid}`,
  );
  if (!issueRes.ok) {
    throw new Error(
      `GitLab issue #${issueIid} failed (${issueRes.status}): ${await issueRes.text()}`,
    );
  }
  const issue = (await issueRes.json()) as {
    iid: number;
    project_id: number;
    title: string;
    description: string | null;
    state: string;
    web_url: string;
    labels?: string[];
    author?: { username?: string; name?: string };
    assignees?: Array<{ username?: string; name?: string }>;
    created_at?: string;
    updated_at?: string;
    milestone?: {
      id: number;
      title: string;
      state?: string;
    } | null;
    task_completion_status?: {
      count?: number;
      completed_count?: number;
    };
  };

  const projectId = issue.project_id;

  const [notes, links] = await Promise.all([
    listIssueNotesUi(projectId, issueIid),
    listIssueLinksUi(projectId, issueIid),
  ]);

  const { extractIssueIids } = await import("./linked-context.js");
  const mentionText = [
    issue.title,
    issue.description ?? "",
    ...notes.map((n) => n.body),
  ].join("\n");
  const mentioned = extractIssueIids(mentionText, issueIid);

  // Task-list style children: "- [ ] #123" / "* [x] #123"
  const taskListIids = new Set<number>();
  const taskListRe =
    /^\s*[-*]\s*\[[ xX]\]\s*.*?#(\d+)\b/gm;
  let tm: RegExpExecArray | null;
  const desc = issue.description ?? "";
  while ((tm = taskListRe.exec(desc)) !== null) {
    const iid = Number(tm[1]);
    if (iid > 0 && iid !== issueIid) taskListIids.add(iid);
  }

  const byIid = new Map<number, RelatedIssueUi>();
  for (const link of links) byIid.set(link.iid, link);

  const missing = [
    ...new Set([...mentioned, ...taskListIids]),
  ].filter((iid) => !byIid.has(iid));

  const fetched = await Promise.all(
    missing.slice(0, 20).map(async (iid) => {
      const res = await gitlabFetch(
        "GET",
        `/projects/${projectId}/issues/${iid}`,
      );
      if (!res.ok) return null;
      const row = (await res.json()) as {
        iid: number;
        title: string;
        state: string;
        web_url: string;
        labels?: string[];
      };
      const source: RelatedIssueUi["source"] = taskListIids.has(iid)
        ? "task_list"
        : "mention";
      return {
        iid: row.iid,
        title: row.title,
        state: row.state,
        url: row.web_url,
        labels: row.labels ?? [],
        source,
      } satisfies RelatedIssueUi;
    }),
  );
  for (const item of fetched) {
    if (item) byIid.set(item.iid, item);
  }

  // Prefer task_list / is_child-like ordering
  const related = [...byIid.values()].sort((a, b) => {
    const rank = (s: RelatedIssueUi["source"]) =>
      s === "task_list" ? 0 : s === "issue_links" ? 1 : 2;
    return rank(a.source) - rank(b.source) || a.iid - b.iid;
  });

  return {
    projectId,
    issueIid: issue.iid,
    title: issue.title,
    description: issue.description ?? "",
    state: issue.state,
    url: issue.web_url,
    labels: issue.labels ?? [],
    assignees: (issue.assignees ?? [])
      .filter((a) => a.username)
      .map((a) => ({
        username: a.username!,
        name: a.name || a.username!,
      })),
    author: issue.author?.username,
    createdAt: issue.created_at,
    updatedAt: issue.updated_at,
    milestone: mapMilestone(issue.milestone),
    taskCompletion: issue.task_completion_status
      ? {
          count: issue.task_completion_status.count ?? 0,
          completedCount: issue.task_completion_status.completed_count ?? 0,
        }
      : undefined,
    notes,
    related,
  };
}

async function listIssueNotesUi(
  projectId: number,
  issueIid: number,
): Promise<IssueNoteUi[]> {
  const notes: IssueNoteUi[] = [];
  let page = 1;
  while (page <= 10) {
    const res = await gitlabFetch(
      "GET",
      `/projects/${projectId}/issues/${issueIid}/notes?per_page=100&page=${page}&sort=asc`,
    );
    if (!res.ok) break;
    const batch = (await res.json()) as Array<{
      id: number;
      body?: string;
      system?: boolean;
      created_at?: string;
      author?: { username?: string; name?: string };
    }>;
    if (!batch.length) break;
    for (const n of batch) {
      notes.push({
        id: n.id,
        body: n.body ?? "",
        author: n.author?.username || n.author?.name || "unknown",
        createdAt: n.created_at ?? "",
        system: Boolean(n.system),
      });
    }
    if (batch.length < 100) break;
    page += 1;
  }
  return notes;
}

async function listIssueLinksUi(
  projectId: number,
  issueIid: number,
): Promise<RelatedIssueUi[]> {
  const res = await gitlabFetch(
    "GET",
    `/projects/${projectId}/issues/${issueIid}/links`,
  );
  if (!res.ok) return [];
  const rows = (await res.json()) as Array<{
    link_type?: string;
    issue?: {
      iid?: number;
      title?: string;
      state?: string;
      web_url?: string;
      labels?: string[];
    };
  }>;
  return rows.flatMap((row) => {
    const issue = row.issue;
    if (!issue?.iid) return [];
    return [
      {
        iid: issue.iid,
        title: issue.title ?? `#${issue.iid}`,
        state: issue.state ?? "unknown",
        url: issue.web_url ?? "",
        labels: issue.labels ?? [],
        linkType: row.link_type,
        source: "issue_links" as const,
      },
    ];
  });
}
