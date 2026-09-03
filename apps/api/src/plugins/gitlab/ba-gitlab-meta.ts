import { fetchGitlabIdentityFromToken } from "./identity.js";

async function baGitlabGet(
  host: string,
  token: string,
  apiPath: string,
): Promise<Response> {
  const base = host.replace(/\/$/, "");
  return fetch(`${base}/api/v4${apiPath}`, {
    headers: { "PRIVATE-TOKEN": token },
  });
}

function encodeProject(gitlabPath: string): string {
  return encodeURIComponent(gitlabPath.trim().replace(/^\/+|\/+$/g, ""));
}

export async function fetchBaProjectMembers(
  gitlabHost: string,
  token: string,
  gitlabPath: string,
): Promise<Array<{ id: number; username: string; name: string }>> {
  const project = encodeProject(gitlabPath);
  const members: Array<{ id: number; username: string; name: string }> = [];
  let page = 1;
  while (page <= 10) {
    const res = await baGitlabGet(
      gitlabHost,
      token,
      `/projects/${project}/members/all?per_page=100&page=${page}`,
    );
    if (!res.ok) {
      throw new Error(
        `GitLab members failed (${res.status}): ${await res.text()}`,
      );
    }
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
        name: m.name || m.username,
      })),
    );
    if (batch.length < 100) break;
    page += 1;
  }
  return members;
}

export async function fetchBaProjectLabels(
  gitlabHost: string,
  token: string,
  gitlabPath: string,
): Promise<
  Array<{ name: string; color?: string; textColor?: string; description?: string }>
> {
  const project = encodeProject(gitlabPath);
  const labels: Array<{
    name: string;
    color?: string;
    textColor?: string;
    description?: string;
  }> = [];
  let page = 1;
  while (page <= 10) {
    const res = await baGitlabGet(
      gitlabHost,
      token,
      `/projects/${project}/labels?per_page=100&page=${page}`,
    );
    if (!res.ok) {
      throw new Error(
        `GitLab labels failed (${res.status}): ${await res.text()}`,
      );
    }
    const batch = (await res.json()) as Array<{
      name: string;
      color?: string;
      text_color?: string;
      description?: string;
    }>;
    if (!batch.length) break;
    labels.push(
      ...batch.map((l) => ({
        name: l.name,
        color: l.color,
        textColor: l.text_color,
        description: l.description,
      })),
    );
    if (batch.length < 100) break;
    page += 1;
  }
  return labels;
}

export async function fetchBaProjectMilestones(
  gitlabHost: string,
  token: string,
  gitlabPath: string,
): Promise<Array<{ id: number; title: string; state?: string }>> {
  const project = encodeProject(gitlabPath);
  const milestones: Array<{ id: number; title: string; state?: string }> = [];
  let page = 1;
  while (page <= 10) {
    const res = await baGitlabGet(
      gitlabHost,
      token,
      `/projects/${project}/milestones?state=active&per_page=100&page=${page}`,
    );
    if (!res.ok) {
      throw new Error(
        `GitLab milestones failed (${res.status}): ${await res.text()}`,
      );
    }
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
  return milestones.sort((a, b) => a.title.localeCompare(b.title));
}

export async function resolveBaMilestoneId(
  gitlabHost: string,
  token: string,
  gitlabPath: string,
  title: string,
): Promise<number | null> {
  const trimmed = title.trim();
  if (!trimmed) return null;
  const milestones = await fetchBaProjectMilestones(
    gitlabHost,
    token,
    gitlabPath,
  );
  const hit = milestones.find(
    (m) => m.title.toLowerCase() === trimmed.toLowerCase(),
  );
  return hit?.id ?? null;
}

/**
 * Resolve assignee for BA publish.
 * Verifies PAT against the **BA project GitLab host** (not global GITLAB_BASE_URL).
 */
export async function resolveBaAssigneeUsername(
  token: string,
  assignee?: string,
  gitlabHost?: string,
): Promise<string> {
  const picked = assignee?.trim().replace(/^@/, "");
  if (picked) return picked;
  try {
    const profile = await fetchGitlabIdentityFromToken(token, gitlabHost);
    return profile.username;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const host = (gitlabHost || "").replace(/\/$/, "") || "(default)";
    throw new Error(`GitLab token invalid on ${host}: ${detail}`);
  }
}
