import { requireRuntimeContext } from "./runtime.js";

/** Cursor API key: per-user runtime only (no .env fallback). */
export function resolveCursorApiKey(): string {
  const key = requireRuntimeContext().cursorApiKey?.trim();
  if (key) return key;
  throw new Error(
    "Chưa có Cursor API key — nhập khi Run (sẽ được mã hóa và lưu)",
  );
}

/** Per-user model from UI, else auto. */
export function resolveCursorModel(): string {
  return requireRuntimeContext().cursorModel?.trim() || "auto";
}

/** Local clone path from the selected project (user workspace). */
export function resolveRepoPath(): string {
  const path = requireRuntimeContext().repoPath?.trim();
  if (path) return path;
  throw new Error("No repo path — join a project with local repo path");
}

/** GitLab project path (group/repo) from the selected project. */
export function resolveGitlabProjectPath(): string {
  const path = requireRuntimeContext().gitlabPath?.trim();
  if (path) return path;
  throw new Error("No GitLab project — select a joined project");
}

/** GitLab username of the logged-in user. */
export function resolveAssigneeUsername(): string {
  const u = requireRuntimeContext().gitlabUsername?.trim();
  if (u) return u;
  throw new Error("No GitLab username — login first");
}
