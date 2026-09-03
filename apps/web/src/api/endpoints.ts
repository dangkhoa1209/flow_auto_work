/**
 * Centralized API paths — never hard-code URLs in components.
 * Use `path()` helpers for dynamic segments.
 */
export const API = {
  auth: {
    bootstrap: "/api/auth/bootstrap",
    login: "/api/auth/login",
    register: "/api/auth/register",
    refresh: "/api/auth/refresh",
    logout: "/api/auth/logout",
  },
  me: {
    root: "/api/me",
    preferences: "/api/me/preferences",
    handoffPrefs: "/api/me/handoff-prefs",
    secrets: "/api/me/secrets",
    cursorKey: "/api/me/cursor-key",
    cursorPats: "/api/me/cursor-pats",
    cursorPat: (patId: string) =>
      `/api/me/cursor-pats/${encodeURIComponent(patId)}`,
    cursorPatActive: (patId: string) =>
      `/api/me/cursor-pats/${encodeURIComponent(patId)}/active`,
    cursorModels: "/api/me/cursor-models",
    googleStatus: "/api/me/google/status",
    googleAuthUrl: "/api/me/google/auth-url",
    googleRevoke: "/api/me/google/revoke",
    integrations: "/api/me/integrations",
    password: "/api/me/password",
    project: (projectId: string) =>
      `/api/me/projects/${encodeURIComponent(projectId)}`,
    projectMilestones: (projectId: string) =>
      `/api/me/projects/${encodeURIComponent(projectId)}/milestones`,
  },
  admin: {
    baProjects: "/api/admin/ba-projects",
    baProject: (id: string) =>
      `/api/admin/ba-projects/${encodeURIComponent(id)}`,
    baClone: (id: string) =>
      `/api/admin/ba-projects/${encodeURIComponent(id)}/clone`,
    baCloneStatus: (id: string) =>
      `/api/admin/ba-projects/${encodeURIComponent(id)}/clone-status`,
    baTestDb: (id: string) =>
      `/api/admin/ba-projects/${encodeURIComponent(id)}/test-db`,
    cursorSettings: "/api/admin/settings/cursor",
    cursorModels: "/api/admin/settings/cursor-models",
    cursorPats: "/api/admin/settings/cursor-pats",
    cursorPat: (patId: string) =>
      `/api/admin/settings/cursor-pats/${encodeURIComponent(patId)}`,
    cursorPatActive: (patId: string) =>
      `/api/admin/settings/cursor-pats/${encodeURIComponent(patId)}/active`,
    taskTypeLabels: "/api/admin/settings/task-type-labels",
    baFeatures: "/api/admin/settings/ba-features",
    users: "/api/admin/users",
    user: (id: string) => `/api/admin/users/${encodeURIComponent(id)}`,
    userDisable: (id: string) =>
      `/api/admin/users/${encodeURIComponent(id)}/disable`,
    userEnable: (id: string) =>
      `/api/admin/users/${encodeURIComponent(id)}/enable`,
    userPassword: (id: string) =>
      `/api/admin/users/${encodeURIComponent(id)}/password`,
    cursorUsage: "/api/admin/cursor-usage",
  },
  ba: {
    projects: "/api/ba/projects",
    projectGitlabMeta: (id: string) =>
      `/api/ba/projects/${encodeURIComponent(id)}/gitlab-meta`,
    threads: "/api/ba/threads",
    thread: (id: string) => `/api/ba/threads/${encodeURIComponent(id)}`,
    messages: (id: string) =>
      `/api/ba/threads/${encodeURIComponent(id)}/messages`,
    stop: (id: string) =>
      `/api/ba/threads/${encodeURIComponent(id)}/stop`,
    draftIssue: (id: string) =>
      `/api/ba/threads/${encodeURIComponent(id)}/draft-issue`,
    requirements: "/api/ba/requirements",
    requirement: (id: string) =>
      `/api/ba/requirements/${encodeURIComponent(id)}`,
    requirementRunStep: (id: string) =>
      `/api/ba/requirements/${encodeURIComponent(id)}/run-step`,
    requirementStop: (id: string) =>
      `/api/ba/requirements/${encodeURIComponent(id)}/stop`,
    requirementEnsureThread: (id: string) =>
      `/api/ba/requirements/${encodeURIComponent(id)}/ensure-thread`,
    taskDrafts: "/api/ba/task-drafts",
    taskDraft: (id: string) =>
      `/api/ba/task-drafts/${encodeURIComponent(id)}`,
    taskDraftPublish: (id: string) =>
      `/api/ba/task-drafts/${encodeURIComponent(id)}/publish`,
    taskDraftParseChat: "/api/ba/task-drafts/parse-chat",
    googleStatus: "/api/ba/google/status",
    googleAuthUrl: "/api/ba/google/auth-url",
    googleRevoke: "/api/ba/google/revoke",
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
    generateTestcases: (id: string) =>
      `/api/jobs/${encodeURIComponent(id)}/generate-testcases`,
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
    createMr: (id: string) =>
      `/api/jobs/${encodeURIComponent(id)}/create-mr`,
    completionActions: (id: string) =>
      `/api/jobs/${encodeURIComponent(id)}/completion-actions`,
    commits: (id: string) =>
      `/api/jobs/${encodeURIComponent(id)}/commits`,
    commit: (id: string) =>
      `/api/jobs/${encodeURIComponent(id)}/commit`,
    discardChanges: (id: string) =>
      `/api/jobs/${encodeURIComponent(id)}/discard-changes`,
    groupCommit: (id: string) =>
      `/api/jobs/${encodeURIComponent(id)}/group-commit`,
    commitMode: (id: string) =>
      `/api/jobs/${encodeURIComponent(id)}/commit-mode`,
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
    googleStatus: (id: string) =>
      `/api/jobs/${encodeURIComponent(id)}/google/status`,
    googleDetect: (id: string) =>
      `/api/jobs/${encodeURIComponent(id)}/google/detect`,
    googleInclude: (id: string) =>
      `/api/jobs/${encodeURIComponent(id)}/google/include`,
    googleRevoke: (id: string) =>
      `/api/jobs/${encodeURIComponent(id)}/google/revoke`,
    googleContinue: (id: string) =>
      `/api/jobs/${encodeURIComponent(id)}/google/continue`,
    figmaStatus: (id: string) =>
      `/api/jobs/${encodeURIComponent(id)}/figma/status`,
    figmaDetect: (id: string) =>
      `/api/jobs/${encodeURIComponent(id)}/figma/detect`,
    figmaInclude: (id: string) =>
      `/api/jobs/${encodeURIComponent(id)}/figma/include`,
    figmaContinue: (id: string) =>
      `/api/jobs/${encodeURIComponent(id)}/figma/continue`,
  },
  google: {
    authUrl: (jobId: string) =>
      `/api/google/auth-url?jobId=${encodeURIComponent(jobId)}`,
  },
  tasks: {
    list: "/api/tasks",
    one: (iid: number | string) => `/api/tasks/${iid}`,
    update: "/api/tasks/update",
  },
  meta: {
    members: "/api/meta/members",
    labels: "/api/meta/labels",
    milestones: "/api/meta/milestones",
    completionDefaults: "/api/meta/completion-defaults",
  },
  status: "/api/status",
  events: "/api/events",
  terminal: {
    status: "/api/terminal/status",
  },
  stats: {
    /** Query: days, from, to, status, workspaceProjectId, allProjects, q */
    daily: "/api/stats/daily",
    analyze: "/api/stats/analyze",
  },
  gitlab: {
    preview: "/api/gitlab/preview",
    file: "/api/gitlab/file",
  },
  fs: {
    browse: "/api/fs/browse",
  },
  devops: {
    scripts: "/api/devops/scripts",
    script: (id: string) =>
      `/api/devops/scripts/${encodeURIComponent(id)}`,
    queue: "/api/devops/queue",
    events: "/api/devops/events",
    builds: "/api/devops/builds",
    build: (id: string) => `/api/devops/builds/${encodeURIComponent(id)}`,
    buildLog: (id: string) =>
      `/api/devops/builds/${encodeURIComponent(id)}/log`,
    buildStream: (id: string) =>
      `/api/devops/builds/${encodeURIComponent(id)}/stream`,
    buildCancel: (id: string) =>
      `/api/devops/builds/${encodeURIComponent(id)}/cancel`,
    buildStdin: (id: string) =>
      `/api/devops/builds/${encodeURIComponent(id)}/stdin`,
  },
} as const;

/** Endpoints that must not attach Bearer / trigger refresh */
export const PUBLIC_AUTH_PATHS = new Set<string>([
  API.auth.bootstrap,
  API.auth.login,
  API.auth.register,
  API.auth.refresh,
]);
