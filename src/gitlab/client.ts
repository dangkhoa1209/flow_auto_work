import { getConfig } from "../config.js";
import { logger } from "../logger.js";

async function gitlabFetch(
  method: string,
  apiPath: string,
  body?: unknown,
): Promise<Response> {
  const config = getConfig();
  const url = `${config.GITLAB_BASE_URL.replace(/\/$/, "")}/api/v4${apiPath}`;
  const res = await fetch(url, {
    method,
    headers: {
      "PRIVATE-TOKEN": config.GITLAB_TOKEN,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res;
}

export async function commentOnIssue(
  projectId: number,
  issueIid: number,
  body: string,
): Promise<void> {
  const res = await gitlabFetch(
    "POST",
    `/projects/${projectId}/issues/${issueIid}/notes`,
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
};

/** Open issues assigned to configured user in ALLOWED_PROJECT_PATH. */
export async function listAssignedOpenIssues(): Promise<
  import("../types.js").IssueJob[]
> {
  const config = getConfig();
  const project = encodeURIComponent(config.ALLOWED_PROJECT_PATH);
  const issues: GitlabIssueApi[] = [];
  let page = 1;

  while (page <= 20) {
    const qs = new URLSearchParams({
      state: "opened",
      assignee_username: config.GITLAB_ASSIGNEE_USERNAME,
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
    projectPath: config.ALLOWED_PROJECT_PATH,
    issueIid: raw.iid,
    issueId: raw.id,
    title: raw.title,
    description: raw.description ?? "",
    labels: raw.labels ?? [],
    url: raw.web_url,
    action: "startup_scan",
  }));
}
