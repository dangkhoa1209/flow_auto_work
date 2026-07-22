/** Workspace multi-user / multi-project types */

export type WorkspaceUser = {
  /** GitLab username (lowercase id) */
  id: string;
  gitlabUsername: string;
  displayName?: string;
  /** AES-GCM ciphertext — never expose to UI */
  gitlabTokenEnc?: string;
  cursorApiKeyEnc?: string;
  /**
   * Cursor model id for agent runs (`auto` or e.g. composer-2.5).
   * Not a secret — returned in public user payload.
   */
  cursorModel?: string;
  createdAt: string;
  updatedAt: string;
};

/** Safe user for API responses (no secrets) */
export type WorkspaceUserPublic = {
  id: string;
  gitlabUsername: string;
  displayName?: string;
  hasGitlabToken: boolean;
  hasCursorApiKey: boolean;
  /** Preferred Cursor model; default auto */
  cursorModel: string;
  createdAt: string;
  updatedAt: string;
};

export type WorkspaceProject = {
  id: string;
  /** e.g. kiemnv/aihr_v3 */
  gitlabPath: string;
  gitlabProjectId?: number;
  displayName: string;
  /** Absolute local clone path on this machine */
  repoPath: string;
  createdAt: string;
  updatedAt: string;
  createdByUsername: string;
};

export type WorkspaceMembership = {
  id: string;
  userId: string;
  projectId: string;
  /**
   * Project / base branch — fork point when auto-creating feat/<iid>/slug.
   * Usually main / develop / default remote branch.
   */
  baseBranch?: string;
  /**
   * Fixed work branch — if set, agent only commits here.
   * If empty, each Run creates/uses feat/<iid>/<short-english-slug>.
   */
  workBranch?: string;
  role: "dev" | "pm" | "admin";
  joinedAt: string;
  updatedAt: string;
};

export type MembershipWithProject = WorkspaceMembership & {
  project: WorkspaceProject;
};

export function toPublicUser(u: WorkspaceUser): WorkspaceUserPublic {
  return {
    id: u.id,
    gitlabUsername: u.gitlabUsername,
    displayName: u.displayName,
    hasGitlabToken: Boolean(u.gitlabTokenEnc),
    hasCursorApiKey: Boolean(u.cursorApiKeyEnc),
    cursorModel: (u.cursorModel?.trim() || "auto"),
    createdAt: u.createdAt,
    updatedAt: u.updatedAt,
  };
}

export function projectIdFromPath(gitlabPath: string): string {
  return gitlabPath
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9/_-]+/g, "-")
    .replace(/\/+/g, "__");
}

export function membershipId(userId: string, projectId: string): string {
  return `${userId}::${projectId}`;
}
