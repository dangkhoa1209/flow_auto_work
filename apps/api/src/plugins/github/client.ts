import { logger } from "../../logger.js";
import { requireRuntimeContext } from "../../workspace/runtime.js";

export type GitHubUser = {
  id: number;
  login: string;
  name?: string | null;
};

function normalizeHost(host?: string): string {
  const h = (host || "github.com").trim().replace(/^https?:\/\//i, "").replace(/\/$/, "");
  return h || "github.com";
}

/** api.github.com for github.com; otherwise GHE `/api/v3`. */
export function githubApiBase(host?: string): string {
  const h = normalizeHost(host);
  if (h === "github.com" || h === "www.github.com") {
    return "https://api.github.com";
  }
  return `https://${h}/api/v3`;
}

export function githubWebBase(host?: string): string {
  const h = normalizeHost(host);
  return `https://${h}`;
}

function parseOwnerRepo(path: string): { owner: string; repo: string } {
  const clean = path.trim().replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
  const parts = clean.split("/").filter(Boolean);
  if (parts.length < 2) {
    throw new Error(`GitHub path must look like owner/repo (got: ${path})`);
  }
  return { owner: parts[0], repo: parts.slice(1).join("/") };
}

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "flow-auto-work",
  };
}

async function githubFetch(
  method: string,
  apiPath: string,
  opts?: {
    token?: string;
    host?: string;
    body?: unknown;
  },
): Promise<Response> {
  const rt = (() => {
    try {
      return requireRuntimeContext();
    } catch {
      return undefined;
    }
  })();
  const token = opts?.token ?? rt?.gitlabToken;
  if (!token) throw new Error("GitHub token required");
  const host = opts?.host ?? rt?.gitlabHost ?? "github.com";
  const url = `${githubApiBase(host)}${apiPath.startsWith("/") ? apiPath : `/${apiPath}`}`;
  return fetch(url, {
    method,
    headers: authHeaders(token),
    body: opts?.body === undefined ? undefined : JSON.stringify(opts.body),
  });
}

function rtPath(): string {
  const path = requireRuntimeContext().gitlabPath?.trim();
  if (!path) throw new Error("No GitHub repo path in runtime");
  return path;
}

function rtHost(): string {
  return requireRuntimeContext().gitlabHost || "github.com";
}

export async function verifyGithubToken(
  token: string,
  host?: string,
): Promise<{ id: number; username: string; name?: string }> {
  const res = await githubFetch("GET", "/user", { token, host });
  if (!res.ok) {
    throw new Error(
      `GitHub token invalid (${res.status}): ${await res.text()}`,
    );
  }
  const data = (await res.json()) as GitHubUser;
  if (!data.login) throw new Error("GitHub /user missing login");
  return {
    id: data.id,
    username: data.login,
    name: data.name ?? undefined,
  };
}

export async function fetchGithubRepo(
  repoPath: string,
  token: string,
  host?: string,
): Promise<{ id: number; pathWithNamespace: string; name: string; defaultBranch?: string }> {
  const { owner, repo } = parseOwnerRepo(repoPath);
  const res = await githubFetch("GET", `/repos/${owner}/${repo}`, {
    token,
    host,
  });
  if (!res.ok) {
    throw new Error(
      `GitHub repo ${repoPath} failed (${res.status}): ${await res.text()}`,
    );
  }
  const data = (await res.json()) as {
    id: number;
    full_name: string;
    name: string;
    default_branch?: string;
  };
  return {
    id: data.id,
    pathWithNamespace: data.full_name,
    name: data.name,
    defaultBranch: data.default_branch,
  };
}

export async function listMyGithubRepos(
  token: string,
  host?: string,
): Promise<
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
      per_page: "100",
      page: String(page),
      sort: "updated",
      affiliation: "owner,collaborator,organization_member",
    });
    const res = await githubFetch("GET", `/user/repos?${qs}`, { token, host });
    if (!res.ok) {
      throw new Error(
        `GitHub list repos failed (${res.status}): ${await res.text()}`,
      );
    }
    const batch = (await res.json()) as Array<{
      id: number;
      full_name: string;
      name: string;
      default_branch?: string;
    }>;
    if (!batch.length) break;
    out.push(
      ...batch.map((r) => ({
        id: r.id,
        pathWithNamespace: r.full_name,
        name: r.name,
        defaultBranch: r.default_branch,
      })),
    );
    if (batch.length < 100) break;
    page += 1;
  }
  return out;
}

export async function listGithubBranches(
  repoPath: string,
  token: string,
  host?: string,
): Promise<Array<{ name: string; default?: boolean }>> {
  const { owner, repo } = parseOwnerRepo(repoPath);
  const meta = await fetchGithubRepo(repoPath, token, host);
  const defaultBranch = meta.defaultBranch;
  const out: Array<{ name: string; default?: boolean }> = [];
  let page = 1;
  while (page <= 20) {
    const res = await githubFetch(
      "GET",
      `/repos/${owner}/${repo}/branches?per_page=100&page=${page}`,
      { token, host },
    );
    if (!res.ok) {
      throw new Error(
        `GitHub list branches failed (${res.status}): ${await res.text()}`,
      );
    }
    const batch = (await res.json()) as Array<{ name: string }>;
    if (!batch.length) break;
    out.push(
      ...batch.map((b) => ({
        name: b.name,
        default: Boolean(defaultBranch && b.name === defaultBranch),
      })),
    );
    if (batch.length < 100) break;
    page += 1;
  }
  return out;
}

type GhIssue = {
  id: number;
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  state: string;
  labels?: Array<{ name?: string } | string>;
  assignees?: Array<{ login?: string; name?: string | null }>;
  user?: { login?: string };
  created_at?: string;
  updated_at?: string;
  milestone?: { id: number; title: string; state?: string } | null;
  pull_request?: unknown;
};

function labelNames(raw: GhIssue["labels"]): string[] {
  if (!raw) return [];
  return raw
    .map((l) => (typeof l === "string" ? l : l.name || ""))
    .map((s) => s.trim())
    .filter(Boolean);
}

function mapMilestone(
  raw: GhIssue["milestone"],
): import("../../types.js").IssueMilestone | null {
  if (!raw?.id || !raw.title?.trim()) return null;
  return {
    id: raw.id,
    title: raw.title.trim(),
    state: raw.state,
  };
}

export async function listAssignedOpenGithubIssues(): Promise<
  import("../../types.js").IssueJob[]
> {
  const repoPath = rtPath();
  const host = rtHost();
  const token = requireRuntimeContext().gitlabToken;
  const profile = await verifyGithubToken(token, host);
  const { owner, repo } = parseOwnerRepo(repoPath);
  const repoMeta = await fetchGithubRepo(repoPath, token, host);
  const issues: GhIssue[] = [];
  let page = 1;
  while (page <= 20) {
    const qs = new URLSearchParams({
      state: "open",
      assignee: profile.username,
      per_page: "100",
      page: String(page),
      sort: "updated",
      direction: "asc",
    });
    const res = await githubFetch(
      "GET",
      `/repos/${owner}/${repo}/issues?${qs}`,
      { token, host },
    );
    if (!res.ok) {
      throw new Error(
        `GitHub list issues failed (${res.status}): ${await res.text()}`,
      );
    }
    const batch = (await res.json()) as GhIssue[];
    if (!batch.length) break;
    // GitHub returns PRs in the issues list — skip them
    issues.push(...batch.filter((i) => !i.pull_request));
    if (batch.length < 100) break;
    page += 1;
  }
  return issues.map((raw) => ({
    projectId: repoMeta.id,
    projectPath: repoPath,
    issueIid: raw.number,
    issueId: raw.id,
    title: raw.title,
    description: raw.body ?? "",
    labels: labelNames(raw.labels),
    url: raw.html_url,
    action: "startup_scan",
    milestone: mapMilestone(raw.milestone),
  }));
}

export async function fetchGithubIssueAsJob(
  issueIid: number,
  repoPathOverride?: string,
): Promise<import("../../types.js").IssueJob | null> {
  const repoPath = repoPathOverride?.trim() || rtPath();
  const host = rtHost();
  const token = requireRuntimeContext().gitlabToken;
  const { owner, repo } = parseOwnerRepo(repoPath);
  const repoMeta = await fetchGithubRepo(repoPath, token, host);
  const res = await githubFetch(
    "GET",
    `/repos/${owner}/${repo}/issues/${issueIid}`,
    { token, host },
  );
  if (!res.ok) return null;
  const raw = (await res.json()) as GhIssue;
  if (raw.pull_request) return null;
  return {
    projectId: repoMeta.id,
    projectPath: repoPath,
    issueIid: raw.number,
    issueId: raw.id,
    title: raw.title,
    description: raw.body ?? "",
    labels: labelNames(raw.labels),
    url: raw.html_url,
    action: "ui_related",
    milestone: mapMilestone(raw.milestone),
  };
}

export async function commentOnGithubIssue(
  issueIid: number,
  body: string,
  repoPath?: string,
): Promise<void> {
  const path = repoPath?.trim() || rtPath();
  const { owner, repo } = parseOwnerRepo(path);
  const res = await githubFetch(
    "POST",
    `/repos/${owner}/${repo}/issues/${issueIid}/comments`,
    { body: { body } },
  );
  if (!res.ok) {
    throw new Error(
      `GitHub comment failed (${res.status}): ${await res.text()}`,
    );
  }
}

export async function applyGithubIssueActions(opts: {
  projectId: number | string;
  issueIid: number;
  assignees?: string[];
  labels?: string[];
  removeLabels?: string[];
  labelMode?: "add" | "set";
  comment?: string;
}): Promise<void> {
  const repoPath =
    typeof opts.projectId === "string" && opts.projectId.includes("/")
      ? opts.projectId
      : rtPath();
  const { owner, repo } = parseOwnerRepo(repoPath);
  const host = rtHost();
  const token = requireRuntimeContext().gitlabToken;

  if (opts.comment?.trim()) {
    await commentOnGithubIssue(opts.issueIid, opts.comment.trim(), repoPath);
  }

  const assignees = (opts.assignees ?? []).map((s) => s.trim()).filter(Boolean);
  const addLabels = (opts.labels ?? []).map((s) => s.trim()).filter(Boolean);
  const removeLabels = (opts.removeLabels ?? [])
    .map((s) => s.trim())
    .filter(Boolean);
  const labelMode = opts.labelMode ?? "add";

  if (
    !assignees.length &&
    !addLabels.length &&
    !removeLabels.length &&
    labelMode !== "set"
  ) {
    return;
  }

  // Fetch current labels when adding/removing
  let nextLabels: string[] | undefined;
  if (addLabels.length || removeLabels.length || labelMode === "set") {
    if (labelMode === "set") {
      nextLabels = addLabels;
    } else {
      const cur = await fetchGithubIssueAsJob(opts.issueIid, repoPath);
      const set = new Set(cur?.labels ?? []);
      for (const l of addLabels) set.add(l);
      for (const l of removeLabels) set.delete(l);
      nextLabels = [...set];
    }
  }

  const payload: Record<string, unknown> = {};
  if (assignees.length) payload.assignees = assignees;
  if (nextLabels) payload.labels = nextLabels;

  if (Object.keys(payload).length === 0) return;

  const res = await githubFetch(
    "PATCH",
    `/repos/${owner}/${repo}/issues/${opts.issueIid}`,
    { token, host, body: payload },
  );
  if (!res.ok) {
    throw new Error(
      `GitHub update issue failed (${res.status}): ${await res.text()}`,
    );
  }
  logger.info("Applied GitHub issue actions", {
    issueIid: opts.issueIid,
    assignees,
    labels: nextLabels,
  });
}

export async function listGithubProjectLabels(
  repoPath?: string,
): Promise<
  Array<{
    name: string;
    color?: string;
    textColor?: string;
    description?: string;
  }>
> {
  const path = repoPath?.trim() || rtPath();
  const { owner, repo } = parseOwnerRepo(path);
  const labels: Array<{
    name: string;
    color?: string;
    description?: string;
  }> = [];
  let page = 1;
  while (page <= 10) {
    const res = await githubFetch(
      "GET",
      `/repos/${owner}/${repo}/labels?per_page=100&page=${page}`,
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
        color: l.color ? `#${l.color.replace(/^#/, "")}` : undefined,
        description: l.description,
      })),
    );
    if (batch.length < 100) break;
    page += 1;
  }
  return labels;
}

export async function listGithubMilestones(
  repoPath: string,
  token: string,
  host?: string,
): Promise<Array<{ id: number; title: string; state?: string }>> {
  const { owner, repo } = parseOwnerRepo(repoPath);
  const milestones: Array<{ id: number; title: string; state?: string }> = [];
  let page = 1;
  while (page <= 10) {
    const res = await githubFetch(
      "GET",
      `/repos/${owner}/${repo}/milestones?state=all&per_page=100&page=${page}`,
      { token, host },
    );
    if (!res.ok) break;
    const batch = (await res.json()) as Array<{
      id: number;
      title: string;
      state?: string;
    }>;
    if (!batch.length) break;
    milestones.push(
      ...batch
        .map((m) => ({
          id: m.id,
          title: (m.title || "").trim(),
          state: m.state,
        }))
        .filter((m) => m.title),
    );
    if (batch.length < 100) break;
    page += 1;
  }
  return milestones;
}

export async function listGithubCollaborators(): Promise<
  Array<{ id: number; username: string; name: string }>
> {
  const { owner, repo } = parseOwnerRepo(rtPath());
  const members: Array<{ id: number; username: string; name: string }> = [];
  let page = 1;
  while (page <= 10) {
    const res = await githubFetch(
      "GET",
      `/repos/${owner}/${repo}/collaborators?per_page=100&page=${page}`,
    );
    if (!res.ok) break;
    const batch = (await res.json()) as Array<{
      id: number;
      login: string;
      name?: string | null;
    }>;
    if (!batch.length) break;
    members.push(
      ...batch.map((m) => ({
        id: m.id,
        username: m.login,
        name: m.name || m.login,
      })),
    );
    if (batch.length < 100) break;
    page += 1;
  }
  return members;
}

export async function getGithubIssueUiDetail(
  issueIid: number,
): Promise<import("../gitlab/client.js").IssueDetailUi | null> {
  const repoPath = rtPath();
  const host = rtHost();
  const token = requireRuntimeContext().gitlabToken;
  const { owner, repo } = parseOwnerRepo(repoPath);
  const repoMeta = await fetchGithubRepo(repoPath, token, host);
  const res = await githubFetch(
    "GET",
    `/repos/${owner}/${repo}/issues/${issueIid}`,
  );
  if (!res.ok) return null;
  const raw = (await res.json()) as GhIssue;
  if (raw.pull_request) return null;

  const notes: import("../gitlab/client.js").IssueNoteUi[] = [];
  let page = 1;
  while (page <= 10) {
    const cRes = await githubFetch(
      "GET",
      `/repos/${owner}/${repo}/issues/${issueIid}/comments?per_page=100&page=${page}`,
    );
    if (!cRes.ok) break;
    const batch = (await cRes.json()) as Array<{
      id: number;
      body: string;
      user?: { login?: string };
      created_at: string;
    }>;
    if (!batch.length) break;
    notes.push(
      ...batch.map((n) => ({
        id: n.id,
        body: n.body || "",
        author: n.user?.login || "unknown",
        createdAt: n.created_at,
        system: false,
      })),
    );
    if (batch.length < 100) break;
    page += 1;
  }

  return {
    projectId: repoMeta.id,
    issueIid: raw.number,
    title: raw.title,
    description: raw.body ?? "",
    state: raw.state === "open" ? "opened" : raw.state,
    url: raw.html_url,
    labels: labelNames(raw.labels),
    assignees: (raw.assignees ?? [])
      .filter((a) => a.login)
      .map((a) => ({
        username: a.login!,
        name: a.name || a.login!,
      })),
    author: raw.user?.login,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    milestone: mapMilestone(raw.milestone),
    notes,
    related: [],
  };
}

export async function createGithubIssue(opts: {
  title: string;
  description?: string;
  labels?: string[];
  assignees?: string[];
}): Promise<{
  issueIid: number;
  issueId: number;
  url: string;
  title: string;
  assignees: string[];
}> {
  const { owner, repo } = parseOwnerRepo(rtPath());
  const payload: Record<string, unknown> = {
    title: opts.title,
    body: opts.description || undefined,
  };
  if (opts.labels?.length) payload.labels = opts.labels;
  if (opts.assignees?.length) payload.assignees = opts.assignees;
  const res = await githubFetch("POST", `/repos/${owner}/${repo}/issues`, {
    body: payload,
  });
  if (!res.ok) {
    throw new Error(
      `GitHub create issue failed (${res.status}): ${await res.text()}`,
    );
  }
  const data = (await res.json()) as GhIssue;
  return {
    issueIid: data.number,
    issueId: data.id,
    url: data.html_url,
    title: data.title,
    assignees: (data.assignees ?? [])
      .map((a) => a.login)
      .filter((x): x is string => Boolean(x)),
  };
}

export async function createGithubPullRequest(opts: {
  sourceBranch: string;
  targetBranch: string;
  title: string;
  description?: string;
}): Promise<{ iid: number; webUrl: string }> {
  const { owner, repo } = parseOwnerRepo(rtPath());
  const res = await githubFetch("POST", `/repos/${owner}/${repo}/pulls`, {
    body: {
      title: opts.title,
      head: opts.sourceBranch,
      base: opts.targetBranch,
      body: opts.description || undefined,
    },
  });
  if (!res.ok) {
    throw new Error(
      `GitHub create PR failed (${res.status}): ${await res.text()}`,
    );
  }
  const data = (await res.json()) as { number: number; html_url: string };
  return { iid: data.number, webUrl: data.html_url };
}

export async function findOpenGithubPullRequest(opts: {
  sourceBranch: string;
  targetBranch?: string;
}): Promise<{ iid: number; webUrl: string } | null> {
  const { owner, repo } = parseOwnerRepo(rtPath());
  const qs = new URLSearchParams({
    state: "open",
    head: `${owner}:${opts.sourceBranch}`,
    per_page: "10",
  });
  if (opts.targetBranch) qs.set("base", opts.targetBranch);
  const res = await githubFetch("GET", `/repos/${owner}/${repo}/pulls?${qs}`);
  if (!res.ok) return null;
  const batch = (await res.json()) as Array<{
    number: number;
    html_url: string;
  }>;
  const first = batch[0];
  if (!first) return null;
  return { iid: first.number, webUrl: first.html_url };
}

export async function mergeGithubPullRequest(opts: {
  pullNumber: number;
  mergeMethod?: "merge" | "squash" | "rebase";
}): Promise<{ sha?: string }> {
  const { owner, repo } = parseOwnerRepo(rtPath());
  const res = await githubFetch(
    "PUT",
    `/repos/${owner}/${repo}/pulls/${opts.pullNumber}/merge`,
    {
      body: {
        merge_method: opts.mergeMethod || "merge",
      },
    },
  );
  if (!res.ok) {
    throw new Error(
      `GitHub merge PR failed (${res.status}): ${await res.text()}`,
    );
  }
  const data = (await res.json()) as { sha?: string };
  return { sha: data.sha };
}
