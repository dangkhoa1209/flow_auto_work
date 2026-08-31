import path from "node:path";
import { getConfig } from "../config.js";
import { getRepoRoot } from "../repoRoot.js";

export type CloneStatus = "pending" | "cloning" | "ready" | "failed";

/** Remote forge for Workbench projects (BA stays GitLab-only). */
export type GitProvider = "gitlab" | "github";

export function normalizeGitProvider(
  raw?: string | null,
): GitProvider {
  return raw === "github" ? "github" : "gitlab";
}

/** Platform capability roles (QC is independent of GitLab membership role). */
export type UserRole = "dev" | "admin" | "qc" | "ba" | "pd" | "devops";

/** Roles selectable at registration (admin is seed-only). */
export const REGISTERABLE_ROLES: readonly UserRole[] = [
  "dev",
  "qc",
  "pd",
  "ba",
  "devops",
] as const;

export type WorkspaceUser = {
  /** Lowercase username id */
  id: string;
  /** Display / login username (same as id normally) */
  gitlabUsername: string;
  passwordHash?: string;
  displayName?: string;
  /** Legacy — prefer project-level token */
  gitlabTokenEnc?: string;
  /** @deprecated Migrated to cursorPats — kept for one-time read */
  cursorApiKeyEnc?: string;
  /** Cursor API keys (encrypted) — user picks one as active */
  cursorPats?: CursorPat[];
  activeCursorPatId?: string;
  cursorModel?: string;
  /**
   * Google OAuth (BA / shared) — đọc Docs, Sheets, Excel trên Drive.
   * Shape giống JobGoogleAuth.
   */
  googleAuth?: {
    email?: string;
    refreshTokenEnc: string;
    accessTokenEnc?: string;
    accessExpiresAt?: string;
    scopes: string[];
    sheetIds?: string[];
    authorizedAt: string;
    revokedAt?: string;
  };
  /** Figma PAT (encrypted) — user level, shared across projects */
  figmaTokenEnc?: string;
  /** Capability roles — include `"qc"` for QC Automation APIs */
  roles?: UserRole[];
  /**
   * Labels & handoff prefs per project (synced across devices).
   * Key = workspace project id.
   */
  handoffPrefsByProject?: Record<string, HandoffPrefs>;
  createdAt: string;
  updatedAt: string;
};

export type CursorPat = {
  id: string;
  label: string;
  keyEnc: string;
  createdAt: string;
  updatedAt: string;
};

export type CursorPatPublic = {
  id: string;
  label: string;
  createdAt: string;
  updatedAt: string;
  isActive: boolean;
};

/** Prefill for Start / Done awaiting handoff — stored per user+project. */
export type HandoffPrefs = {
  assignee?: string | null;
  processingLabel?: string;
  onStartLabels?: string[];
  addLabels?: string[];
  removeLabels?: string[];
  comment?: string;
};

export type WorkspaceUserPublic = {
  id: string;
  gitlabUsername: string;
  displayName?: string;
  hasGitlabToken: boolean;
  hasCursorApiKey: boolean;
  cursorPats: CursorPatPublic[];
  activeCursorPatId?: string | null;
  hasGoogleAuth: boolean;
  googleEmail?: string;
  hasFigmaToken: boolean;
  hasPassword: boolean;
  cursorModel: string;
  roles: UserRole[];
  createdAt: string;
  updatedAt: string;
};

/** Admin user list — includes disabled (soft-deleted) state. */
export type AdminUserPublic = WorkspaceUserPublic & {
  disabled: boolean;
  disabledAt?: string | null;
  /** Seeded root admin — immutable via admin user management. */
  isRootAdmin: boolean;
  /** BA Project Chatbox messages (includes soft-deleted). */
  baChatMessageCount?: number;
  /** Active (not soft-deleted) BA chat messages. */
  baChatMessageActiveCount?: number;
  /** Soft-deleted BA chat messages. */
  baChatMessageDeletedCount?: number;
  /** BA threads owned by user (includes soft-deleted). */
  baChatThreadCount?: number;
};

/** Username of the seeded root admin (`npm run seed`). */
export const ROOT_ADMIN_USERNAME = "admin";

export function isRootAdminUsername(username: string): boolean {
  return normUserId(username) === ROOT_ADMIN_USERNAME;
}

/** All roles an admin may assign. */
export const ALL_USER_ROLES: readonly UserRole[] = [
  "dev",
  "admin",
  "qc",
  "ba",
  "pd",
  "devops",
] as const;

export type WorkspaceProject = {
  id: string;
  /** Owner user id */
  userId: string;
  projectName: string;
  displayName: string;
  /**
   * Remote forge. Missing / unknown → gitlab (legacy rows).
   * Host/path/token/id fields below are forge-agnostic storage.
   */
  gitProvider?: GitProvider;
  /** Remote host — gitlab.com / github.com / self-hosted */
  gitlabHost: string;
  /** e.g. group/repo or owner/repo */
  gitlabPath: string;
  /** PAT encrypted — attached to project (GitLab or GitHub classic) */
  gitlabTokenEnc?: string;
  /** Figma Personal Access Token (encrypted) — legacy per-project; prefer user.figmaTokenEnc */
  figmaTokenEnc?: string;
  gitlabProjectId?: number;
  /** Absolute clone path */
  localPath: string;
  /** Alias of localPath (legacy consumers) */
  repoPath: string;
  mainBranch?: string;
  workingBranch?: string;
  /**
   * Default Auto/Manual commit for new jobs in this project.
   * Per-job `commitMode` can still override. Missing → auto.
   */
  defaultCommitMode?: "manual" | "auto";
  /**
   * When non-empty, Workbench Open tasks only show issues whose
   * milestone title is in this list. Empty / missing → no restriction.
   */
  allowedMilestones?: string[];
  /** Verify command run after agent code phase (e.g. "npm run typecheck") */
  verifyCommand?: string;
  isActive: boolean;
  cloneStatus: CloneStatus;
  cloneError?: string;
  createdAt: string;
  updatedAt: string;
  createdByUsername: string;
};

/** Synthetic membership for UI / older callers — branches come from project. */
export type WorkspaceMembership = {
  id: string;
  userId: string;
  projectId: string;
  baseBranch?: string;
  workBranch?: string;
  role: "dev" | "admin";
  joinedAt: string;
  updatedAt: string;
};

export type MembershipWithProject = WorkspaceMembership & {
  project: WorkspaceProject;
};

export function normalizeUserRoles(roles?: UserRole[] | null): UserRole[] {
  const set = new Set<UserRole>();
  for (const r of roles || []) {
    if (
      r === "dev" ||
      r === "admin" ||
      r === "qc" ||
      r === "ba" ||
      r === "pd" ||
      r === "devops"
    ) {
      set.add(r);
    }
  }
  const out = [...set];
  // Legacy accounts with no roles → dev. Admin always has explicit "admin" role.
  if (out.length === 0) return ["dev"];
  return out;
}

export function userHasRole(
  u: Pick<WorkspaceUser, "roles"> | null | undefined,
  role: UserRole,
): boolean {
  return normalizeUserRoles(u?.roles).includes(role);
}

/** Project chat audience: pd / ba / qc (not dev or devops — those have their own home). */
export function isBaAudience(
  roles?: UserRole[] | null | Pick<WorkspaceUser, "roles">,
): boolean {
  const list = Array.isArray(roles)
    ? roles
    : normalizeUserRoles(
        (roles as Pick<WorkspaceUser, "roles"> | null | undefined)?.roles,
      );
  const r = normalizeUserRoles(list as UserRole[]);
  if (r.includes("admin")) return false;
  if (r.includes("dev")) return false;
  if (r.includes("devops")) return false;
  return r.includes("ba") || r.includes("pd") || r.includes("qc");
}

export function isAdminRole(roles?: UserRole[] | null): boolean {
  return normalizeUserRoles(roles).includes("admin");
}

/** Build-script console: devops, dev, or admin. */
export function canAccessDevops(roles?: UserRole[] | null): boolean {
  const r = normalizeUserRoles(roles);
  return r.includes("admin") || r.includes("devops") || r.includes("dev");
}

/** Create/edit/delete build scripts — devops role only (admin may also). */
export function canConfigureDevopsScripts(
  roles?: UserRole[] | null,
): boolean {
  const r = normalizeUserRoles(roles);
  return r.includes("devops") || r.includes("admin");
}

/** Workbench: dev or admin. */
export function canAccessWork(roles?: UserRole[] | null): boolean {
  const r = normalizeUserRoles(roles);
  return r.includes("admin") || r.includes("dev");
}

/** Project chat UI/API: ba audience, dev, devops, or admin. */
export function canAccessBa(roles?: UserRole[] | null): boolean {
  const r = normalizeUserRoles(roles);
  return (
    isAdminRole(r) ||
    canAccessWork(r) ||
    isBaAudience(r) ||
    r.includes("devops")
  );
}

/**
 * Dedicated Devops home: devops role, not admin, not dev (dev → /work).
 */
export function isDevopsAudience(
  roles?: UserRole[] | null | Pick<WorkspaceUser, "roles">,
): boolean {
  const list = Array.isArray(roles)
    ? roles
    : normalizeUserRoles(
        (roles as Pick<WorkspaceUser, "roles"> | null | undefined)?.roles,
      );
  const r = normalizeUserRoles(list as UserRole[]);
  if (r.includes("admin")) return false;
  if (r.includes("dev")) return false;
  return r.includes("devops");
}

/** Post-login / guard home path. */
export function primaryHomePath(roles?: UserRole[] | null): string {
  const r = normalizeUserRoles(roles);
  if (r.includes("admin")) return "/admin";
  if (r.includes("dev")) return "/work";
  if (r.includes("devops")) return "/devops";
  if (isBaAudience(r)) return "/ba";
  return "/work";
}

export function isRegisterableRole(role: string): role is UserRole {
  return (REGISTERABLE_ROLES as readonly string[]).includes(role);
}

/** Shared BA catalog clone path: `project/_ba/<slug>/source` */
export function baProjectLocalPath(slug: string): string {
  const name =
    slug.trim().replace(/[/\\]+/g, "-").replace(/^\.+|\.+$/g, "") || "project";
  return path.join(resolveProjectRoot(), "_ba", name, "source");
}

export function effectiveActiveCursorPatId(u: WorkspaceUser): string | null {
  const activeId = u.activeCursorPatId?.trim();
  if (activeId && u.cursorPats?.some((p) => p.id === activeId && p.keyEnc)) {
    return activeId;
  }
  const first = u.cursorPats?.find((p) => p.keyEnc);
  return first?.id ?? null;
}

export function toPublicCursorPats(
  u: WorkspaceUser,
): { pats: CursorPatPublic[]; activeId: string | null } {
  const activeId = effectiveActiveCursorPatId(u);
  const pats = (u.cursorPats ?? []).map((p) => ({
    id: p.id,
    label: p.label,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    isActive: Boolean(activeId && p.id === activeId),
  }));
  return { pats, activeId };
}

export function userHasActiveCursorKey(u: WorkspaceUser): boolean {
  if (u.cursorApiKeyEnc) return true;
  return Boolean(effectiveActiveCursorPatId(u));
}

export function toPublicUser(u: WorkspaceUser): WorkspaceUserPublic {
  const g = u.googleAuth;
  const hasGoogleAuth = Boolean(g?.refreshTokenEnc && !g.revokedAt);
  const { pats, activeId } = toPublicCursorPats(u);
  return {
    id: u.id,
    gitlabUsername: u.gitlabUsername,
    displayName: u.displayName,
    hasGitlabToken: Boolean(u.gitlabTokenEnc),
    hasCursorApiKey: userHasActiveCursorKey(u),
    cursorPats: pats,
    activeCursorPatId: activeId,
    hasGoogleAuth,
    googleEmail: hasGoogleAuth ? g?.email : undefined,
    hasFigmaToken: Boolean(u.figmaTokenEnc),
    hasPassword: Boolean(u.passwordHash),
    cursorModel: u.cursorModel?.trim() || "auto",
    roles: normalizeUserRoles(u.roles),
    createdAt: u.createdAt,
    updatedAt: u.updatedAt,
  };
}

export function toAdminUser(
  u: WorkspaceUser & { deleted?: boolean; deletedAt?: string | null },
): AdminUserPublic {
  return {
    ...toPublicUser(u),
    disabled: Boolean(u.deleted),
    disabledAt: u.deleted ? u.deletedAt ?? null : null,
    isRootAdmin: isRootAdminUsername(u.id),
  };
}

export function projectIdFromPath(gitlabPath: string): string {
  return gitlabPath
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9/_-]+/g, "-")
    .replace(/\/+/g, "__");
}

export function projectIdForUser(userId: string, projectName: string): string {
  const slug = projectName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return `${normUserId(userId)}__${slug || "project"}`;
}

export function membershipId(userId: string, projectId: string): string {
  return `${normUserId(userId)}::${projectId}`;
}

export function normUserId(username: string): string {
  return username.trim().replace(/^@/, "").toLowerCase();
}

/** Root folder for cloned repos (default `<repo>/project`). */
export function resolveProjectRoot(): string {
  const cfg = getConfig();
  const root = cfg.PROJECT_ROOT?.trim();
  if (root) return path.resolve(root);
  return path.resolve(getRepoRoot(), "project");
}

/**
 * Default clone path: `<PROJECT_ROOT>/{username}/{projectName}/source`
 * e.g. `project/khoadev/ykk/source`
 */
export function defaultLocalPath(username: string, projectName: string): string {
  const name =
    projectName.trim().replace(/[/\\]+/g, "-").replace(/^\.+|\.+$/g, "") ||
    "project";
  return path.join(
    resolveProjectRoot(),
    normUserId(username),
    name,
    "source",
  );
}

export function normalizeGitlabHost(host?: string): string {
  const h = (host || "").trim() || "https://gitlab.com";
  return h.replace(/\/$/, "");
}

export function normalizeGithubHost(host?: string): string {
  const h = (host || "").trim() || "https://github.com";
  return h.replace(/\/$/, "");
}

/** Normalize forge host for storage (scheme + no trailing slash). */
export function normalizeRemoteHost(
  provider: GitProvider,
  host?: string,
): string {
  return provider === "github"
    ? normalizeGithubHost(host)
    : normalizeGitlabHost(host);
}

export function projectToMembership(
  username: string,
  project: WorkspaceProject,
): MembershipWithProject {
  const userId = normUserId(username);
  return {
    id: membershipId(userId, project.id),
    userId,
    projectId: project.id,
    baseBranch: project.mainBranch,
    workBranch: project.workingBranch,
    role: "dev",
    joinedAt: project.createdAt,
    updatedAt: project.updatedAt,
    project,
  };
}
