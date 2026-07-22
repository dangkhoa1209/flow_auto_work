import { getConfig } from "../config.js";
import { logger } from "../logger.js";

export type GitlabIdentity = {
  id: number;
  username: string;
  name?: string;
};

/** Call GitLab /user with a PAT — returns the token owner. */
export async function fetchGitlabIdentityFromToken(
  token: string,
  baseUrl?: string,
): Promise<GitlabIdentity> {
  const config = getConfig();
  const root = (baseUrl || config.GITLAB_BASE_URL).replace(/\/$/, "");
  const res = await fetch(`${root}/api/v4/user`, {
    headers: { "PRIVATE-TOKEN": token.trim() },
  });
  if (!res.ok) {
    throw new Error(
      `GitLab /user failed (${res.status}): ${await res.text()}`,
    );
  }
  const data = (await res.json()) as {
    id: number;
    username?: string;
    name?: string;
  };
  if (!data.username?.trim()) {
    throw new Error("GitLab /user missing username");
  }
  return {
    id: data.id,
    username: data.username.trim(),
    name: data.name,
  };
}

/**
 * If GITLAB_TOKEN is set, resolve the owner username and use it as
 * GITLAB_ASSIGNEE_USERNAME when that env var is empty (or always overwrite from token).
 */
export async function applyGitlabAssigneeFromEnvToken(): Promise<string | null> {
  const config = getConfig();
  const token = config.GITLAB_TOKEN?.trim();
  if (!token) return config.GITLAB_ASSIGNEE_USERNAME?.trim() || null;

  try {
    const identity = await fetchGitlabIdentityFromToken(token);
    config.GITLAB_ASSIGNEE_USERNAME = identity.username;
    if (!config.GITLAB_ASSIGNEE_ID) {
      config.GITLAB_ASSIGNEE_ID = String(identity.id);
    }
    logger.info("Resolved GITLAB_ASSIGNEE_USERNAME from GITLAB_TOKEN", {
      username: identity.username,
      gitlabUserId: identity.id,
    });
    return identity.username;
  } catch (err) {
    logger.warn("Could not resolve username from GITLAB_TOKEN", {
      err: String(err),
    });
    return config.GITLAB_ASSIGNEE_USERNAME?.trim() || null;
  }
}
