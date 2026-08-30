import path from "node:path";
import { getConfig } from "../config.js";
import { getRepoRoot } from "../repoRoot.js";

export type CloneStatus = "pending" | "cloning" | "ready" | "failed";

/** Platform capability roles (QC is independent of GitLab membership role). */
export type UserRole = "dev" | "pm" | "admin" | "qc" | "ba" | "pd" | "devops";

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
  cursorApiKeyEnc?: string;
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
  hasGoogleAuth: boolean;
  googleEmail?: string;
  hasPassword: boolean;
  cursorModel: string;
  roles: UserRole[];
  createdAt: string;
  updatedAt: string;
};

export type WorkspaceProject = {
  id: string;
  /** Owner user id */
  userId: string;
  projectName: string;
  displayName: string;
  gitlabHost: string;
  /** e.g. group/repo */
  gitlabPath: string;
  /** PAT encrypted — attached to project */
  gitlabTokenEnc?: string;
  /** Figma Personal Access Token (encrypted) — workspace/project level */
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
  role: "dev" | "pm" | "admin";
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
      r === "pm" ||
      r === "admin" ||
      r === "qc" ||
      r === "ba" ||
      r === "pd" ||
      r === "devops"
    ) {
      set.add(r);
    }
  }
  return [...set];
}

export function userHasRole(
  u: Pick<WorkspaceUser, "roles"> | null | undefined,
  role: UserRole,
): boolean {
  return normalizeUserRoles(u?.roles).includes(role);
}

/** BA Chat audience: ba / pd / qc-only (not Dev who also toggled QC). */
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
  if (r.includes("ba") || r.includes("pd")) return true;
  if (r.includes("qc") && !r.includes("dev")) return true;
  return false;
}

export function isAdminRole(roles?: UserRole[] | null): boolean {
  return normalizeUserRoles(roles).includes("admin");
}

/** Build-script console: devops role or admin. */
export function canAccessDevops(roles?: UserRole[] | null): boolean {
  const r = normalizeUserRoles(roles);
  return r.includes("admin") || r.includes("devops");
}

/**
 * Dedicated Devops home: has devops, not admin, not BA audience, not WorkBench dev.
 * Users with both `dev` + `devops` still land on /work and open /devops from nav.
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
  if (isBaAudience(r)) return false;
  return r.includes("devops") && !r.includes("dev");
}

/** Post-login / guard home path. */
export function primaryHomePath(roles?: UserRole[] | null): string {
  const r = normalizeUserRoles(roles);
  if (r.includes("admin")) return "/admin";
  if (isBaAudience(r)) return "/ba";
  if (isDevopsAudience(r)) return "/devops";
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

export function toPublicUser(u: WorkspaceUser): WorkspaceUserPublic {
  const g = u.googleAuth;
  const hasGoogleAuth = Boolean(g?.refreshTokenEnc && !g.revokedAt);
  return {
    id: u.id,
    gitlabUsername: u.gitlabUsername,
    displayName: u.displayName,
    hasGitlabToken: Boolean(u.gitlabTokenEnc),
    hasCursorApiKey: Boolean(u.cursorApiKeyEnc),
    hasGoogleAuth,
    googleEmail: hasGoogleAuth ? g?.email : undefined,
    hasPassword: Boolean(u.passwordHash),
    cursorModel: u.cursorModel?.trim() || "auto",
    roles: normalizeUserRoles(u.roles),
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
