import { getConfig } from "../../config.js";

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
