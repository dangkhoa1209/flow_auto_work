/**
 * Centralized API paths — never hard-code URLs in components.
 * Use `path()` helpers for dynamic segments.
 */
export const API = {
  auth: {
    login: "/api/auth/login",
    register: "/api/auth/register",
    refresh: "/api/auth/refresh",
    logout: "/api/auth/logout",
  },
  me: {
    root: "/api/me",
    preferences: "/api/me/preferences",
    secrets: "/api/me/secrets",
    cursorKey: "/api/me/cursor-key",
    cursorModels: "/api/me/cursor-models",
    project: (projectId: string) =>
      `/api/me/projects/${encodeURIComponent(projectId)}`,
  },
  projects: {
    root: "/api/projects",
    defaultPath: "/api/projects/default-path",
    one: (projectId: string) =>
      `/api/projects/${encodeURIComponent(projectId)}`,
    clone: (projectId: string) =>
      `/api/projects/${encodeURIComponent(projectId)}/clone`,
    cloneStatus: (projectId: string) =>
      `/api/projects/${encodeURIComponent(projectId)}/clone-status`,
    activate: (projectId: string) =>
      `/api/projects/${encodeURIComponent(projectId)}/activate`,
  },
  jobs: {
    list: "/api/jobs",
    start: "/api/jobs/start",
    ensure: "/api/jobs/ensure",
    adhoc: "/api/jobs/adhoc",
    byIssue: (iid: number | string) => `/api/jobs/by-issue/${iid}`,
    one: (id: string) => `/api/jobs/${encodeURIComponent(id)}`,
    progress: (id: string) =>
      `/api/jobs/${encodeURIComponent(id)}/progress`,
    chat: (id: string) => `/api/jobs/${encodeURIComponent(id)}/chat`,
    continue: (id: string) =>
      `/api/jobs/${encodeURIComponent(id)}/continue`,
    ask: (id: string) => `/api/jobs/${encodeURIComponent(id)}/ask`,
    kill: (id: string) => `/api/jobs/${encodeURIComponent(id)}/kill`,
    killAll: "/api/jobs/kill-all",
    resetWindow: (id: string) =>
      `/api/jobs/${encodeURIComponent(id)}/reset-window`,
    status: (id: string) => `/api/jobs/${encodeURIComponent(id)}/status`,
    approveDocs: (id: string) =>
      `/api/jobs/${encodeURIComponent(id)}/approve-docs`,
    approveDiff: (id: string) =>
      `/api/jobs/${encodeURIComponent(id)}/approve-diff`,
    merge: (id: string) => `/api/jobs/${encodeURIComponent(id)}/merge`,
    completionActions: (id: string) =>
      `/api/jobs/${encodeURIComponent(id)}/completion-actions`,
    commits: (id: string) =>
      `/api/jobs/${encodeURIComponent(id)}/commits`,
    revertCommit: (id: string, sha: string) =>
      `/api/jobs/${encodeURIComponent(id)}/commits/${encodeURIComponent(sha)}/revert`,
    diff: (id: string) => `/api/jobs/${encodeURIComponent(id)}/diff`,
    issueDraft: (id: string) =>
      `/api/jobs/${encodeURIComponent(id)}/issue-draft`,
    createIssue: (id: string) =>
      `/api/jobs/${encodeURIComponent(id)}/create-issue`,
    notes: (id: string) => `/api/jobs/${encodeURIComponent(id)}/notes`,
    devNotes: (id: string) =>
      `/api/jobs/${encodeURIComponent(id)}/dev-notes`,
  },
  tasks: {
    list: "/api/tasks",
    one: (iid: number | string) => `/api/tasks/${iid}`,
    update: "/api/tasks/update",
  },
  meta: {
    members: "/api/meta/members",
    labels: "/api/meta/labels",
    completionDefaults: "/api/meta/completion-defaults",
  },
  status: "/api/status",
  events: "/api/events",
  stats: {
    daily: "/api/stats/daily",
  },
  gitlab: {
    preview: "/api/gitlab/preview",
    file: "/api/gitlab/file",
  },
  fs: {
    browse: "/api/fs/browse",
  },
} as const;

/** Endpoints that must not attach Bearer / trigger refresh */
export const PUBLIC_AUTH_PATHS = new Set<string>([
  API.auth.login,
  API.auth.register,
  API.auth.refresh,
]);
