import { getConfig } from "../../config.js";
import { requireRuntimeContext } from "../../workspace/runtime.js";

export type GitlabCommitAction = {
  action: "create" | "update" | "delete" | "move";
  file_path: string;
  previous_path?: string;
  content?: string;
  encoding?: "text" | "base64";
};

export type CreateRepositoryCommitOpts = {
  projectIdOrPath: number | string;
  branch: string;
  /** When branch does not exist on GitLab yet */
  startBranch?: string;
  message: string;
  actions: GitlabCommitAction[];
  token?: string;
};

export type GitlabCommitResult = {
  id: string;
  shortId: string;
  title: string;
  message: string;
};

async function gitlabFetch(
  method: string,
  apiPath: string,
  body?: unknown,
  tokenOverride?: string,
): Promise<Response> {
  const config = getConfig();
  const url = `${config.GITLAB_BASE_URL.replace(/\/$/, "")}/api/v4${apiPath}`;
  return fetch(url, {
    method,
    headers: {
      "PRIVATE-TOKEN":
        tokenOverride ?? requireRuntimeContext().gitlabToken,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function projectKey(projectIdOrPath: number | string): string {
  return typeof projectIdOrPath === "string"
    ? encodeURIComponent(projectIdOrPath)
    : String(projectIdOrPath);
}

/** True if branch exists on the GitLab project. */
export async function gitlabBranchExists(
  projectIdOrPath: number | string,
  branch: string,
  token?: string,
): Promise<boolean> {
  const project = projectKey(projectIdOrPath);
  const encBranch = encodeURIComponent(branch);
  const res = await gitlabFetch(
    "GET",
    `/projects/${project}/repository/branches/${encBranch}`,
    undefined,
    token,
  );
  if (res.status === 404) return false;
  if (!res.ok) {
    throw new Error(
      `GitLab branch check failed (${res.status}): ${await res.text()}`,
    );
  }
  return true;
}

/**
 * Create a commit on GitLab via Commits API.
 * Do not set author_* — GitLab attributes the commit to the PAT owner.
 */
export async function createRepositoryCommit(
  opts: CreateRepositoryCommitOpts,
): Promise<GitlabCommitResult> {
  if (!opts.actions.length) {
    throw new Error("createRepositoryCommit: no actions");
  }
  const project = projectKey(opts.projectIdOrPath);
  const body: Record<string, unknown> = {
    branch: opts.branch,
    commit_message: opts.message,
    actions: opts.actions,
  };
  if (opts.startBranch?.trim()) {
    body.start_branch = opts.startBranch.trim();
  }

  const res = await gitlabFetch(
    "POST",
    `/projects/${project}/repository/commits`,
    body,
    opts.token,
  );
  if (!res.ok) {
    throw new Error(
      `GitLab create commit failed (${res.status}): ${await res.text()}`,
    );
  }
  const data = (await res.json()) as {
    id: string;
    short_id?: string;
    title?: string;
    message?: string;
  };
  if (!data.id) {
    throw new Error("GitLab create commit: response missing id");
  }
  return {
    id: data.id,
    shortId: data.short_id || data.id.slice(0, 8),
    title: data.title || "",
    message: data.message || opts.message,
  };
}
