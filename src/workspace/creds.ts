import { getConfig } from "../config.js";
import { getRuntimeContext } from "../workspace/runtime.js";

/** GitLab PRIVATE-TOKEN: runtime user token, else legacy .env */
export function resolveGitlabToken(): string {
  const rt = getRuntimeContext();
  if (rt?.gitlabToken) return rt.gitlabToken;
  const t = getConfig().GITLAB_TOKEN?.trim();
  if (t) return t;
  throw new Error("No GitLab token — login and save your PAT (encrypted)");
}

export function resolveCursorApiKey(): string {
  const rt = getRuntimeContext();
  if (rt?.cursorApiKey) return rt.cursorApiKey;
  const t = getConfig().CURSOR_API_KEY?.trim();
  if (t) return t;
  throw new Error(
    "Chưa có Cursor API key — nhập khi Run (sẽ được mã hóa và lưu)",
  );
}

/** Per-user model from UI, else auto. */
export function resolveCursorModel(): string {
  const rt = getRuntimeContext();
  const fromUser = rt?.cursorModel?.trim();
  if (fromUser) return fromUser;
  return "auto";
}

export function resolveRepoPath(): string {
  const rt = getRuntimeContext();
  if (rt?.repoPath) return rt.repoPath;
  const t = getConfig().AIHR_REPO_PATH?.trim();
  if (t) return t;
  throw new Error("No repo path — join a project with local repo path");
}

export function resolveGitlabProjectPath(): string {
  const rt = getRuntimeContext();
  if (rt?.gitlabPath) return rt.gitlabPath;
  const t = getConfig().ALLOWED_PROJECT_PATH?.trim();
  if (t) return t;
  throw new Error("No GitLab project — select a joined project");
}

export function resolveAssigneeUsername(): string {
  const rt = getRuntimeContext();
  if (rt?.gitlabUsername) return rt.gitlabUsername;
  const t = getConfig().GITLAB_ASSIGNEE_USERNAME?.trim();
  if (t) return t;
  throw new Error("No GitLab username — login first");
}
