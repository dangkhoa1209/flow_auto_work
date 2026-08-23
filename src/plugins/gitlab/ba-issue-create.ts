import { logger } from "../../logger.js";

export type BaCreatedIssue = {
  id: number;
  iid: number;
  title: string;
  description: string;
  webUrl: string;
  labels: string[];
  projectId: number;
};

async function baGitlabRequest(
  method: "POST" | "PUT",
  host: string,
  token: string,
  apiPath: string,
  body: Record<string, unknown>,
): Promise<Response> {
  const base = host.replace(/\/$/, "");
  return fetch(`${base}/api/v4${apiPath}`, {
    method,
    headers: {
      "PRIVATE-TOKEN": token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function baGitlabPost(
  host: string,
  token: string,
  apiPath: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return baGitlabRequest("POST", host, token, apiPath, body);
}

async function resolveUserIds(
  host: string,
  token: string,
  usernames: string[],
): Promise<number[]> {
  const ids: number[] = [];
  for (const username of usernames) {
    const u = encodeURIComponent(username.trim().replace(/^@/, ""));
    if (!u) continue;
    const res = await fetch(
      `${host.replace(/\/$/, "")}/api/v4/users?username=${u}`,
      { headers: { "PRIVATE-TOKEN": token } },
    );
    if (!res.ok) continue;
    const data = (await res.json()) as Array<{ id?: number }>;
    if (data[0]?.id) ids.push(data[0].id);
  }
  return ids;
}

/** Create GitLab issue using BA project token (not runtime context). */
export async function createBaGitlabIssue(opts: {
  gitlabHost: string;
  token: string;
  gitlabPath: string;
  title: string;
  description?: string;
  labels?: string[];
  assignees?: string[];
  milestoneId?: number;
}): Promise<BaCreatedIssue> {
  const title = opts.title.trim();
  if (!title) throw new Error("title required");
  const project = encodeURIComponent(
    opts.gitlabPath.trim().replace(/^\/+|\/+$/g, ""),
  );
  const payload: Record<string, unknown> = {
    title,
    description: opts.description?.trim() || undefined,
  };
  const labels = (opts.labels || []).map((l) => l.trim()).filter(Boolean);
  if (labels.length) payload.labels = labels.join(",");

  const assignees = (opts.assignees || [])
    .map((s) => s.trim().replace(/^@/, ""))
    .filter(Boolean);
  if (assignees.length) {
    const ids = await resolveUserIds(opts.gitlabHost, opts.token, assignees);
    if (ids.length) payload.assignee_ids = ids;
  }
  if (opts.milestoneId) {
    payload.milestone_id = opts.milestoneId;
  }

  const res = await baGitlabPost(
    opts.gitlabHost,
    opts.token,
    `/projects/${project}/issues`,
    payload,
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitLab create issue failed (${res.status}): ${text}`);
  }
  const data = (await res.json()) as {
    id: number;
    iid: number;
    title: string;
    description: string | null;
    web_url: string;
    labels?: string[];
    project_id: number;
  };
  logger.info("BA created GitLab issue", {
    iid: data.iid,
    project: opts.gitlabPath,
  });
  return {
    id: data.id,
    iid: data.iid,
    title: data.title,
    description: data.description || "",
    webUrl: data.web_url,
    labels: data.labels ?? labels,
    projectId: data.project_id,
  };
}

/** Update an existing GitLab issue (BA republish → "cập nhật task cũ"). */
export async function updateBaGitlabIssue(opts: {
  gitlabHost: string;
  token: string;
  gitlabPath: string;
  iid: number;
  title: string;
  description?: string;
  labels?: string[];
  assignees?: string[];
  milestoneId?: number;
}): Promise<BaCreatedIssue> {
  const title = opts.title.trim();
  if (!title) throw new Error("title required");
  const project = encodeURIComponent(
    opts.gitlabPath.trim().replace(/^\/+|\/+$/g, ""),
  );
  const payload: Record<string, unknown> = {
    title,
    description: opts.description?.trim() || undefined,
  };
  const labels = (opts.labels || []).map((l) => l.trim()).filter(Boolean);
  if (labels.length) payload.labels = labels.join(",");

  const assignees = (opts.assignees || [])
    .map((s) => s.trim().replace(/^@/, ""))
    .filter(Boolean);
  if (assignees.length) {
    const ids = await resolveUserIds(opts.gitlabHost, opts.token, assignees);
    if (ids.length) payload.assignee_ids = ids;
  }
  if (opts.milestoneId) {
    payload.milestone_id = opts.milestoneId;
  }

  const res = await baGitlabRequest(
    "PUT",
    opts.gitlabHost,
    opts.token,
    `/projects/${project}/issues/${opts.iid}`,
    payload,
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitLab update issue failed (${res.status}): ${text}`);
  }
  const data = (await res.json()) as {
    id: number;
    iid: number;
    title: string;
    description: string | null;
    web_url: string;
    labels?: string[];
    project_id: number;
  };
  logger.info("BA updated GitLab issue", {
    iid: data.iid,
    project: opts.gitlabPath,
  });
  return {
    id: data.id,
    iid: data.iid,
    title: data.title,
    description: data.description || "",
    webUrl: data.web_url,
    labels: data.labels ?? labels,
    projectId: data.project_id,
  };
}
