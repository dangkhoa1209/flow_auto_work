import { connectMongo } from "../models/connection.js";
import {
  WorkspaceMembershipModel,
  WorkspaceProjectModel,
  WorkspaceUserModel,
} from "../models/workspace.js";
import { rename as fsRename } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { decryptSecret, encryptSecret } from "../plugins/crypto/secrets.js";
import { hashPassword, verifyPassword } from "../auth/password.js";
import { logger } from "../logger.js";
import { pathExists } from "./clone.js";
import {
  defaultLocalPath,
  membershipId,
  normalizeGitlabHost,
  normalizeUserRoles,
  normUserId,
  projectIdForUser,
  projectIdFromPath,
  projectToMembership,
  toPublicUser,
  toAdminUser,
  isRootAdminUsername,
  type AdminUserPublic,
  type MembershipWithProject,
  type WorkspaceMembership,
  type WorkspaceProject,
  type WorkspaceUser,
  type WorkspaceUserPublic,
  type CloneStatus,
  type CursorPat,
  effectiveActiveCursorPatId,
  type HandoffPrefs,
  type UserRole,
} from "./types.js";

/** Segment under PROJECT_ROOT/{user}/ — same rules as defaultLocalPath */
export function projectFolderSegment(projectName: string): string {
  return (
    projectName.trim().replace(/[/\\]+/g, "-").replace(/^\.+|\.+$/g, "") ||
    "project"
  );
}

export async function ensureWorkspaceIndexes(): Promise<void> {
  await WorkspaceUserModel.ensureIndexes();
  await WorkspaceProjectModel.ensureIndexes();
  await WorkspaceMembershipModel.ensureIndexes();
  const db = await connectMongo();
  try {
    await db.collection("workspace_projects").dropIndex("gitlabPath_1");
  } catch {
    /* index may not exist */
  }
}

export async function getUserByUsername(
  username: string,
): Promise<WorkspaceUser | null> {
  const id = normUserId(username);
  if (!id) return null;
  return WorkspaceUserModel.findOne({ id });
}

export async function createOrUpdateUserPassword(opts: {
  username: string;
  password: string;
  displayName?: string;
  /** When set, replaces user roles (e.g. register / seed admin). */
  roles?: UserRole[];
}): Promise<WorkspaceUserPublic> {
  const id = normUserId(opts.username);
  if (!id) throw new Error("username required");
  const now = new Date().toISOString();
  const existing = await getUserByUsername(id);
  const passwordHash = await hashPassword(opts.password);
  const doc: WorkspaceUser = existing ?? {
    id,
    gitlabUsername: opts.username.trim().replace(/^@/, ""),
    createdAt: now,
    updatedAt: now,
  };
  doc.passwordHash = passwordHash;
  if (opts.displayName?.trim()) doc.displayName = opts.displayName.trim();
  if (opts.roles !== undefined) {
    doc.roles = normalizeUserRoles(opts.roles);
  }
  if (!doc.cursorModel) doc.cursorModel = "auto";
  doc.updatedAt = now;
  doc.gitlabUsername = opts.username.trim().replace(/^@/, "");
  if (!existing) {
    await WorkspaceUserModel.purgeSoftDeleted({ id });
  }
  await WorkspaceUserModel.upsertOne({ id }, doc);
  return toPublicUser(doc);
}

export async function changeUserPassword(opts: {
  username: string;
  currentPassword?: string;
  newPassword: string;
}): Promise<WorkspaceUserPublic> {
  const id = normUserId(opts.username);
  const existing = await getUserByUsername(id);
  if (!existing) throw new Error("User not found");
  const newPassword = opts.newPassword.trim();
  if (newPassword.length < 6) {
    throw new Error("Password must be at least 6 characters");
  }
  if (existing.passwordHash) {
    const current = opts.currentPassword?.trim() ?? "";
    if (!current) throw new Error("currentPassword required");
    const ok = await verifyPassword(current, existing.passwordHash);
    if (!ok) throw new Error("Current password incorrect");
  }
  const now = new Date().toISOString();
  const passwordHash = await hashPassword(newPassword);
  await WorkspaceUserModel.updateOne(
    { id },
    { $set: { passwordHash, updatedAt: now } },
  );
  const updated = await getUserByUsername(id);
  if (!updated) throw new Error("User not found after password change");
  return toPublicUser(updated);
}

export async function upsertUserLogin(opts: {
  gitlabUsername: string;
  displayName?: string;
  gitlabToken?: string;
  cursorApiKey?: string;
  cursorModel?: string;
  passwordHash?: string;
}): Promise<WorkspaceUserPublic> {
  const id = normUserId(opts.gitlabUsername);
  if (!id) throw new Error("username required");
  const now = new Date().toISOString();
  const existing = await getUserByUsername(id);
  const doc: WorkspaceUser = existing ?? {
    id,
    gitlabUsername: opts.gitlabUsername.trim().replace(/^@/, ""),
    createdAt: now,
    updatedAt: now,
  };
  if (opts.displayName?.trim()) doc.displayName = opts.displayName.trim();
  if (opts.gitlabToken?.trim()) {
    doc.gitlabTokenEnc = encryptSecret(opts.gitlabToken);
  }
  if (opts.passwordHash) doc.passwordHash = opts.passwordHash;
  if (opts.cursorModel !== undefined) {
    doc.cursorModel = opts.cursorModel.trim() || "auto";
  } else if (!doc.cursorModel) {
    doc.cursorModel = "auto";
  }
  doc.updatedAt = now;
  if (!existing) {
    doc.gitlabUsername = opts.gitlabUsername.trim().replace(/^@/, "");
    await WorkspaceUserModel.purgeSoftDeleted({ id });
  }
  await WorkspaceUserModel.upsertOne({ id }, doc);
  if (opts.cursorApiKey?.trim()) {
    await addOrUpdateCursorPatKey(id, opts.cursorApiKey.trim());
  }
  const saved = await getUserByUsername(id);
  const normalized = saved ? await normalizeUserCursorState(saved) : null;
  return toPublicUser(normalized ?? doc);
}

export async function updateUserPreferences(opts: {
  gitlabUsername: string;
  cursorModel?: string;
}): Promise<WorkspaceUserPublic> {
  const id = normUserId(opts.gitlabUsername);
  const existing = await getUserByUsername(id);
  if (!existing) throw new Error("User not found");
  const now = new Date().toISOString();
  if (opts.cursorModel !== undefined) {
    existing.cursorModel = opts.cursorModel.trim() || "auto";
  }
  existing.updatedAt = now;
  await WorkspaceUserModel.updateOne({ id }, { $set: existing });
  return toPublicUser(existing);
}

/** Enable or disable the QC capability role (“I am QC”). */
export async function setUserQcRole(opts: {
  username: string;
  enabled: boolean;
}): Promise<WorkspaceUserPublic> {
  const id = normUserId(opts.username);
  const existing = await getUserByUsername(id);
  if (!existing) throw new Error("User not found");
  const roles = new Set(normalizeUserRoles(existing.roles));
  if (opts.enabled) roles.add("qc");
  else roles.delete("qc");
  const now = new Date().toISOString();
  existing.roles = [...roles];
  existing.updatedAt = now;
  await WorkspaceUserModel.updateOne(
    { id },
    { $set: { roles: existing.roles, updatedAt: now } },
  );
  return toPublicUser(existing);
}

export async function getHandoffPrefs(
  username: string,
  projectId: string,
): Promise<HandoffPrefs> {
  const user = await getUserByUsername(username);
  if (!user) return {};
  const pid = projectId.trim();
  if (!pid) return {};
  return { ...(user.handoffPrefsByProject?.[pid] ?? {}) };
}

export async function setHandoffPrefs(opts: {
  gitlabUsername: string;
  projectId: string;
  prefs: HandoffPrefs;
}): Promise<HandoffPrefs> {
  const id = normUserId(opts.gitlabUsername);
  const existing = await getUserByUsername(id);
  if (!existing) throw new Error("User not found");
  const pid = opts.projectId.trim();
  if (!pid) throw new Error("projectId required");

  const next: HandoffPrefs = {
    assignee: opts.prefs.assignee?.trim() || null,
    processingLabel:
      typeof opts.prefs.processingLabel === "string" &&
      opts.prefs.processingLabel.trim()
        ? opts.prefs.processingLabel.trim()
        : "On-processing",
    onStartLabels: Array.isArray(opts.prefs.onStartLabels)
      ? opts.prefs.onStartLabels.map((s) => String(s).trim()).filter(Boolean)
      : [],
    addLabels: Array.isArray(opts.prefs.addLabels)
      ? opts.prefs.addLabels.map((s) => String(s).trim()).filter(Boolean)
      : [],
    removeLabels: Array.isArray(opts.prefs.removeLabels)
      ? opts.prefs.removeLabels.map((s) => String(s).trim()).filter(Boolean)
      : [],
    comment:
      typeof opts.prefs.comment === "string" ? opts.prefs.comment.trim() : "",
  };

  const map = { ...(existing.handoffPrefsByProject ?? {}) };
  map[pid] = next;
  const now = new Date().toISOString();
  await WorkspaceUserModel.updateOne(
    { id },
    { $set: { handoffPrefsByProject: map, updatedAt: now } },
  );
  return next;
}

export async function clearCursorApiKey(
  username: string,
): Promise<WorkspaceUserPublic> {
  const id = normUserId(username);
  const existing = await getUserByUsername(id);
  if (!existing) throw new Error("User not found");
  const migrated = await migrateLegacyCursorKeyIfNeeded(existing);
  const activeId = migrated.activeCursorPatId?.trim();
  if (!activeId) {
    const now = new Date().toISOString();
    await WorkspaceUserModel.updateOne(
      { id },
      {
        $unset: { cursorApiKeyEnc: "", cursorPats: "", activeCursorPatId: "" },
        $set: { updatedAt: now },
      },
    );
  } else {
    await deleteCursorPat(username, activeId);
  }
  const updated = await getUserByUsername(id);
  if (!updated) throw new Error("User not found after clear");
  return toPublicUser(updated);
}

function resolveActiveCursorPat(user: WorkspaceUser): CursorPat | null {
  const activeId = effectiveActiveCursorPatId(user);
  if (!activeId) return null;
  return user.cursorPats?.find((p) => p.id === activeId && p.keyEnc) ?? null;
}

function decryptCursorPatKey(pat: CursorPat): string {
  return decryptSecret(pat.keyEnc);
}

/** Migrate legacy single key into cursorPats (persisted). */
export async function migrateLegacyCursorKeyIfNeeded(
  user: WorkspaceUser,
): Promise<WorkspaceUser> {
  if (user.cursorPats?.length) return user;
  if (!user.cursorApiKeyEnc) return user;
  const now = new Date().toISOString();
  const id = randomUUID();
  const pat: CursorPat = {
    id,
    label: "Default",
    keyEnc: user.cursorApiKeyEnc,
    createdAt: now,
    updatedAt: now,
  };
  await WorkspaceUserModel.updateOne(
    { id: user.id },
    {
      $set: { cursorPats: [pat], activeCursorPatId: id, updatedAt: now },
      $unset: { cursorApiKeyEnc: "" },
    },
  );
  const updated = await getUserByUsername(user.id);
  return updated ?? user;
}

/** Migrate legacy key + ensure active PAT id (single-key users work without manual step). */
export async function normalizeUserCursorState(
  user: WorkspaceUser,
): Promise<WorkspaceUser> {
  let u = await migrateLegacyCursorKeyIfNeeded(user);
  const nextActiveId = effectiveActiveCursorPatId(u);
  const storedActive = u.activeCursorPatId?.trim() || null;
  if (nextActiveId && nextActiveId !== storedActive) {
    const now = new Date().toISOString();
    await WorkspaceUserModel.updateOne(
      { id: u.id },
      { $set: { activeCursorPatId: nextActiveId, updatedAt: now } },
    );
    const updated = await getUserByUsername(u.id);
    return updated ?? u;
  }
  return u;
}

async function addOrUpdateCursorPatKey(
  username: string,
  apiKey: string,
): Promise<void> {
  const id = normUserId(username);
  let user = await getUserByUsername(id);
  if (!user) throw new Error("User not found");
  user = await migrateLegacyCursorKeyIfNeeded(user);
  const now = new Date().toISOString();
  const active = resolveActiveCursorPat(user);
  if (active) {
    const pats = (user.cursorPats ?? []).map((p) =>
      p.id === active.id
        ? {
            ...p,
            keyEnc: encryptSecret(apiKey),
            updatedAt: now,
          }
        : p,
    );
    await WorkspaceUserModel.updateOne(
      { id },
      { $set: { cursorPats: pats, updatedAt: now } },
    );
    return;
  }
  const patId = randomUUID();
  const pat: CursorPat = {
    id: patId,
    label: "PAT 1",
    keyEnc: encryptSecret(apiKey),
    createdAt: now,
    updatedAt: now,
  };
  await WorkspaceUserModel.updateOne(
    { id },
    {
      $set: {
        cursorPats: [...(user.cursorPats ?? []), pat],
        activeCursorPatId: patId,
        updatedAt: now,
      },
    },
  );
}

export async function listCursorPats(
  username: string,
): Promise<WorkspaceUserPublic> {
  const id = normUserId(username);
  let user = await getUserByUsername(id);
  if (!user) throw new Error("User not found");
  user = await normalizeUserCursorState(user);
  return toPublicUser(user);
}

export async function createCursorPat(
  username: string,
  opts: { label?: string; apiKey: string },
): Promise<WorkspaceUserPublic> {
  const id = normUserId(username);
  let user = await getUserByUsername(id);
  if (!user) throw new Error("User not found");
  user = await migrateLegacyCursorKeyIfNeeded(user);
  const key = opts.apiKey.trim();
  if (!key) throw new Error("apiKey required");
  const now = new Date().toISOString();
  const patId = randomUUID();
  const label =
    opts.label?.trim() ||
    `PAT ${(user.cursorPats?.length ?? 0) + 1}`;
  const pat: CursorPat = {
    id: patId,
    label,
    keyEnc: encryptSecret(key),
    createdAt: now,
    updatedAt: now,
  };
  const pats = [...(user.cursorPats ?? []), pat];
  const setActive = !user.activeCursorPatId?.trim();
  await WorkspaceUserModel.updateOne(
    { id },
    {
      $set: {
        cursorPats: pats,
        ...(setActive ? { activeCursorPatId: patId } : {}),
        updatedAt: now,
      },
    },
  );
  const updated = await getUserByUsername(id);
  if (!updated) throw new Error("User not found after create");
  return toPublicUser(updated);
}

export async function updateCursorPat(
  username: string,
  patId: string,
  opts: { label?: string; apiKey?: string },
): Promise<WorkspaceUserPublic> {
  const id = normUserId(username);
  let user = await getUserByUsername(id);
  if (!user) throw new Error("User not found");
  user = await migrateLegacyCursorKeyIfNeeded(user);
  const pid = patId.trim();
  const idx = user.cursorPats?.findIndex((p) => p.id === pid) ?? -1;
  if (idx < 0) throw new Error("PAT not found");
  const now = new Date().toISOString();
  const pats = [...(user.cursorPats ?? [])];
  const current = { ...pats[idx] };
  if (opts.label !== undefined) {
    current.label = opts.label.trim() || current.label;
  }
  if (opts.apiKey?.trim()) {
    current.keyEnc = encryptSecret(opts.apiKey.trim());
  }
  current.updatedAt = now;
  pats[idx] = current;
  await WorkspaceUserModel.updateOne(
    { id },
    { $set: { cursorPats: pats, updatedAt: now } },
  );
  const updated = await getUserByUsername(id);
  if (!updated) throw new Error("User not found after update");
  return toPublicUser(updated);
}

export async function setActiveCursorPat(
  username: string,
  patId: string,
): Promise<WorkspaceUserPublic> {
  const id = normUserId(username);
  let user = await getUserByUsername(id);
  if (!user) throw new Error("User not found");
  user = await migrateLegacyCursorKeyIfNeeded(user);
  const pid = patId.trim();
  if (!user.cursorPats?.some((p) => p.id === pid)) {
    throw new Error("PAT not found");
  }
  const now = new Date().toISOString();
  await WorkspaceUserModel.updateOne(
    { id },
    { $set: { activeCursorPatId: pid, updatedAt: now } },
  );
  const updated = await getUserByUsername(id);
  if (!updated) throw new Error("User not found after set active");
  return toPublicUser(updated);
}

export async function deleteCursorPat(
  username: string,
  patId: string,
): Promise<WorkspaceUserPublic> {
  const id = normUserId(username);
  let user = await getUserByUsername(id);
  if (!user) throw new Error("User not found");
  user = await migrateLegacyCursorKeyIfNeeded(user);
  const pid = patId.trim();
  const pats = (user.cursorPats ?? []).filter((p) => p.id !== pid);
  if (pats.length === user.cursorPats?.length) {
    throw new Error("PAT not found");
  }
  const now = new Date().toISOString();
  let activeCursorPatId = user.activeCursorPatId;
  if (activeCursorPatId === pid) {
    activeCursorPatId = pats[0]?.id;
  }
  if (activeCursorPatId) {
    await WorkspaceUserModel.updateOne(
      { id },
      {
        $set: {
          cursorPats: pats,
          activeCursorPatId,
          updatedAt: now,
        },
      },
    );
  } else {
    await WorkspaceUserModel.updateOne(
      { id },
      {
        $set: { cursorPats: pats, updatedAt: now },
        $unset: { activeCursorPatId: "" },
      },
    );
  }
  const updated = await getUserByUsername(id);
  if (!updated) throw new Error("User not found after delete");
  return toPublicUser(updated);
}

export async function getActiveCursorApiKey(
  username: string,
): Promise<string | undefined> {
  const user = await getUserByUsername(username);
  if (!user) return undefined;
  const migrated = await normalizeUserCursorState(user);
  const pat = resolveActiveCursorPat(migrated);
  if (pat) return decryptCursorPatKey(pat);
  if (migrated.cursorApiKeyEnc) return decryptSecret(migrated.cursorApiKeyEnc);
  return undefined;
}

export async function setUserGoogleAuth(
  username: string,
  googleAuth: WorkspaceUser["googleAuth"],
): Promise<WorkspaceUserPublic> {
  const id = normUserId(username);
  const existing = await getUserByUsername(id);
  if (!existing) throw new Error("User not found");
  const now = new Date().toISOString();
  existing.googleAuth = googleAuth;
  existing.updatedAt = now;
  await WorkspaceUserModel.updateOne(
    { id },
    { $set: { googleAuth, updatedAt: now } },
  );
  return toPublicUser(existing);
}

export async function clearUserGoogleAuth(
  username: string,
): Promise<WorkspaceUserPublic> {
  const id = normUserId(username);
  const existing = await getUserByUsername(id);
  if (!existing) throw new Error("User not found");
  const now = new Date().toISOString();
  await WorkspaceUserModel.updateOne(
    { id },
    { $unset: { googleAuth: "" }, $set: { updatedAt: now } },
  );
  const updated = await getUserByUsername(id);
  if (!updated) throw new Error("User not found after clear");
  return toPublicUser(updated);
}

export async function setUserFigmaToken(
  username: string,
  figmaToken: string | null,
): Promise<WorkspaceUserPublic> {
  const id = normUserId(username);
  const existing = await getUserByUsername(id);
  if (!existing) throw new Error("User not found");
  const now = new Date().toISOString();
  if (figmaToken === null || figmaToken === "") {
    await WorkspaceUserModel.updateOne(
      { id },
      { $unset: { figmaTokenEnc: "" }, $set: { updatedAt: now } },
    );
  } else {
    await WorkspaceUserModel.updateOne(
      { id },
      {
        $set: {
          figmaTokenEnc: encryptSecret(figmaToken.trim()),
          updatedAt: now,
        },
      },
    );
  }
  const updated = await getUserByUsername(id);
  if (!updated) throw new Error("User not found after update");
  return toPublicUser(updated);
}

/** Cursor key from user; GitLab token from project if projectId given, else user legacy / active project. */
export async function getUserSecrets(
  username: string,
  projectId?: string,
): Promise<{
  gitlabToken?: string;
  cursorApiKey?: string;
} | null> {
  const user = await getUserByUsername(username);
  if (!user) return null;
  const migrated = await normalizeUserCursorState(user);
  const pat = resolveActiveCursorPat(migrated);
  const cursorApiKey = pat
    ? decryptCursorPatKey(pat)
    : migrated.cursorApiKeyEnc
      ? decryptSecret(migrated.cursorApiKeyEnc)
      : undefined;

  let gitlabToken: string | undefined;
  if (projectId) {
    const project = await getProject(projectId);
    if (project?.userId === normUserId(username) && project.gitlabTokenEnc) {
      gitlabToken = decryptSecret(project.gitlabTokenEnc);
    }
  }
  if (!gitlabToken) {
    const active = await getActiveProjectForUser(username);
    if (active?.gitlabTokenEnc) {
      gitlabToken = decryptSecret(active.gitlabTokenEnc);
    }
  }
  if (!gitlabToken && user.gitlabTokenEnc) {
    gitlabToken = decryptSecret(user.gitlabTokenEnc);
  }
  return { gitlabToken, cursorApiKey };
}

export async function getProjectSecrets(projectId: string): Promise<{
  gitlabToken?: string;
  figmaToken?: string;
} | null> {
  const project = await getProject(projectId);
  if (!project) return null;
  const out: { gitlabToken?: string; figmaToken?: string } = {};
  if (project.gitlabTokenEnc) {
    out.gitlabToken = decryptSecret(project.gitlabTokenEnc);
  }
  const user = await getUserByUsername(project.userId);
  if (user?.figmaTokenEnc) {
    out.figmaToken = decryptSecret(user.figmaTokenEnc);
  } else if (project.figmaTokenEnc) {
    out.figmaToken = decryptSecret(project.figmaTokenEnc);
  }
  if (!out.gitlabToken && !out.figmaToken) return null;
  return out;
}

export async function listProjects(): Promise<WorkspaceProject[]> {
  return WorkspaceProjectModel.findMany({ sort: { displayName: 1 } });
}

export async function listProjectsForUser(
  username: string,
): Promise<WorkspaceProject[]> {
  const userId = normUserId(username);
  return WorkspaceProjectModel.findMany({
    filter: { userId },
    sort: { isActive: -1, updatedAt: -1 },
  });
}

export async function getProject(
  projectId: string,
): Promise<WorkspaceProject | null> {
  return WorkspaceProjectModel.findOne({ id: projectId });
}

export async function getActiveProjectForUser(
  username: string,
): Promise<WorkspaceProject | null> {
  const userId = normUserId(username);
  const active = await WorkspaceProjectModel.findOne({
    userId,
    isActive: true,
  });
  if (active) return active;
  const first = await WorkspaceProjectModel.findMany({
    filter: { userId },
    sort: { updatedAt: -1 },
    limit: 1,
  });
  return first[0] ?? null;
}

export async function getProjectByPath(
  gitlabPath: string,
): Promise<WorkspaceProject | null> {
  const path = gitlabPath.trim().replace(/^\/+|\/+$/g, "");
  return WorkspaceProjectModel.findOne({
    gitlabPath: {
      $regex: `^${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
      $options: "i",
    },
  });
}

function syncRepoPath(doc: WorkspaceProject): WorkspaceProject {
  doc.repoPath = doc.localPath;
  return doc;
}

export async function createUserProject(opts: {
  username: string;
  projectName: string;
  gitlabPath: string;
  gitlabToken?: string;
  gitlabHost?: string;
  localPath?: string;
  mainBranch?: string;
  workingBranch?: string;
  defaultCommitMode?: "manual" | "auto";
  allowedMilestones?: string[];
  displayName?: string;
  gitlabProjectId?: number;
  isActive?: boolean;
}): Promise<WorkspaceProject> {
  const userId = normUserId(opts.username);
  const projectName = opts.projectName.trim();
  if (!projectName) throw new Error("projectName required");
  const gitlabPath = opts.gitlabPath.trim().replace(/^\/+|\/+$/g, "");
  if (!gitlabPath.includes("/")) {
    throw new Error("gitlabPath must look like group/project");
  }
  const id = projectIdForUser(userId, projectName);
  const now = new Date().toISOString();
  const existing = await getProject(id);
  if (existing) throw new Error(`Project name already exists: ${projectName}`);

  // Case-insensitive + folder-segment clash (path …/{name}/source)
  const nameKey = projectFolderSegment(projectName).toLowerCase();
  const siblings = await WorkspaceProjectModel.findMany({ filter: { userId } });
  const clash = siblings.find(
    (p) =>
      p.projectName.trim().toLowerCase() === projectName.toLowerCase() ||
      projectFolderSegment(p.projectName).toLowerCase() === nameKey,
  );
  if (clash) {
    throw new Error(
      `Project name already exists (folder path): ${projectName}`,
    );
  }

  const localPath =
    opts.localPath?.trim() || defaultLocalPath(userId, projectName);
  const doc: WorkspaceProject = {
    id,
    userId,
    projectName,
    displayName: projectName,
    gitlabHost: normalizeGitlabHost(opts.gitlabHost),
    gitlabPath,
    localPath,
    repoPath: localPath,
    mainBranch: opts.mainBranch?.trim() || undefined,
    workingBranch: opts.workingBranch?.trim() || undefined,
    defaultCommitMode:
      opts.defaultCommitMode === "manual" ? "manual" : "auto",
    allowedMilestones: opts.allowedMilestones?.length
      ? opts.allowedMilestones
      : undefined,
    isActive: Boolean(opts.isActive),
    cloneStatus: "pending",
    gitlabProjectId: opts.gitlabProjectId,
    createdAt: now,
    updatedAt: now,
    createdByUsername: userId,
  };
  if (opts.gitlabToken?.trim()) {
    doc.gitlabTokenEnc = encryptSecret(opts.gitlabToken.trim());
  }
  if (doc.isActive) {
    await WorkspaceProjectModel.updateMany(
      { userId },
      { isActive: false, updatedAt: now },
    );
  }
  await WorkspaceProjectModel.purgeSoftDeleted({ id });
  await WorkspaceProjectModel.insert(doc);
  return syncRepoPath(doc);
}

/** Legacy upsert by gitlab path — migrates into user-owned shape when possible. */
export async function upsertProject(opts: {
  gitlabPath: string;
  repoPath: string;
  displayName?: string;
  gitlabProjectId?: number;
  createdByUsername: string;
  userId?: string;
  projectName?: string;
  gitlabHost?: string;
  gitlabToken?: string;
  mainBranch?: string;
  workingBranch?: string;
}): Promise<WorkspaceProject> {
  const userId = normUserId(opts.userId || opts.createdByUsername);
  const gitlabPath = opts.gitlabPath.trim().replace(/^\/+|\/+$/g, "");
  if (!gitlabPath.includes("/")) {
    throw new Error("gitlabPath must look like group/project");
  }
  const projectName =
    opts.projectName?.trim() || gitlabPath.split("/").pop() || "project";
  const id = projectIdForUser(userId, projectName);
  const now = new Date().toISOString();
  const existing = await getProject(id);
  const localPath = opts.repoPath.trim();
  const doc: WorkspaceProject = {
    id,
    userId,
    projectName,
    displayName:
      opts.displayName?.trim() || existing?.displayName || projectName,
    gitlabHost: normalizeGitlabHost(opts.gitlabHost || existing?.gitlabHost),
    gitlabPath,
    localPath,
    repoPath: localPath,
    mainBranch: opts.mainBranch ?? existing?.mainBranch,
    workingBranch: opts.workingBranch ?? existing?.workingBranch,
    isActive: existing?.isActive ?? false,
    cloneStatus: existing?.cloneStatus ?? "ready",
    gitlabProjectId: opts.gitlabProjectId ?? existing?.gitlabProjectId,
    gitlabTokenEnc: existing?.gitlabTokenEnc,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    createdByUsername: existing?.createdByUsername ?? opts.createdByUsername,
  };
  if (opts.gitlabToken?.trim()) {
    doc.gitlabTokenEnc = encryptSecret(opts.gitlabToken.trim());
  }
  if (!existing) {
    await WorkspaceProjectModel.purgeSoftDeleted({ id });
  }
  await WorkspaceProjectModel.upsertOne({ id }, doc);
  return syncRepoPath(doc);
}

export async function updateProjectFields(
  projectId: string,
  patch: Partial<{
    localPath: string;
    mainBranch: string;
    workingBranch: string;
    defaultCommitMode: "manual" | "auto";
    allowedMilestones?: string[];
    displayName: string;
    projectName: string;
    gitlabHost: string;
    gitlabPath: string;
    gitlabToken: string;
    /** Plaintext Figma PAT — encrypted to figmaTokenEnc; empty string clears */
    figmaToken: string | null;
    gitlabProjectId: number;
    cloneStatus: CloneStatus;
    cloneError: string | null;
    isActive: boolean;
  }>,
): Promise<WorkspaceProject> {
  const existing = await getProject(projectId);
  if (!existing) throw new Error(`Project not found: ${projectId}`);
  const now = new Date().toISOString();

  if (patch.projectName !== undefined) {
    const nextName = patch.projectName.trim();
    if (!nextName) throw new Error("projectName required");
    if (nextName !== existing.projectName) {
      const nameKey = projectFolderSegment(nextName).toLowerCase();
      const siblings = await WorkspaceProjectModel.findMany({
        filter: { userId: existing.userId, id: { $ne: projectId } },
      });
      const clash = siblings.find(
        (p) =>
          p.projectName.trim().toLowerCase() === nextName.toLowerCase() ||
          projectFolderSegment(p.projectName).toLowerCase() === nameKey ||
          p.id === projectIdForUser(existing.userId, nextName),
      );
      if (clash) {
        throw new Error(
          `Project name already exists (folder path): ${nextName}`,
        );
      }
      existing.projectName = nextName;
      if (patch.displayName === undefined) {
        existing.displayName = nextName;
      }
    }
  }

  if (patch.localPath !== undefined) {
    existing.localPath = patch.localPath.trim();
    existing.repoPath = existing.localPath;
  }
  if (patch.mainBranch !== undefined) {
    existing.mainBranch = patch.mainBranch.trim() || undefined;
  }
  if (patch.workingBranch !== undefined) {
    existing.workingBranch = patch.workingBranch.trim() || undefined;
  }
  if (patch.defaultCommitMode !== undefined) {
    existing.defaultCommitMode =
      patch.defaultCommitMode === "manual" ? "manual" : "auto";
  }
  if (patch.allowedMilestones !== undefined) {
    const titles = [
      ...new Set(
        (patch.allowedMilestones || [])
          .map((t) => String(t).trim())
          .filter(Boolean),
      ),
    ].sort((a, b) => a.localeCompare(b));
    existing.allowedMilestones = titles.length ? titles : undefined;
  }
  if (patch.displayName !== undefined) {
    existing.displayName = patch.displayName.trim() || existing.projectName;
  }
  if (patch.gitlabHost !== undefined) {
    existing.gitlabHost = normalizeGitlabHost(patch.gitlabHost);
  }
  if (patch.gitlabPath !== undefined) {
    existing.gitlabPath = patch.gitlabPath.trim().replace(/^\/+|\/+$/g, "");
  }
  if (patch.gitlabToken?.trim()) {
    existing.gitlabTokenEnc = encryptSecret(patch.gitlabToken.trim());
  }
  if (patch.figmaToken === null || patch.figmaToken === "") {
    delete existing.figmaTokenEnc;
  } else if (typeof patch.figmaToken === "string" && patch.figmaToken.trim()) {
    existing.figmaTokenEnc = encryptSecret(patch.figmaToken.trim());
  }
  if (patch.gitlabProjectId !== undefined) {
    existing.gitlabProjectId = patch.gitlabProjectId;
  }
  if (patch.cloneStatus !== undefined) {
    existing.cloneStatus = patch.cloneStatus;
  }
  if (patch.cloneError === null) {
    delete existing.cloneError;
  } else if (patch.cloneError !== undefined) {
    existing.cloneError = patch.cloneError;
  }
  if (patch.isActive === true) {
    await WorkspaceProjectModel.updateMany(
      { userId: existing.userId },
      { isActive: false, updatedAt: now },
    );
    existing.isActive = true;
  } else if (patch.isActive === false) {
    existing.isActive = false;
  }
  existing.updatedAt = now;
  await WorkspaceProjectModel.updateOne(
    { id: projectId },
    { $set: existing },
  );
  return syncRepoPath(existing);
}

/**
 * Rename Flow project folder on disk when path follows
 * `…/{username}/{projectName}/source`. Returns new localPath if renamed.
 */
export async function renameProjectLocalFolder(opts: {
  username: string;
  oldProjectName: string;
  newProjectName: string;
  currentLocalPath: string;
}): Promise<{ localPath: string; renamed: boolean }> {
  const oldSeg = projectFolderSegment(opts.oldProjectName);
  const newSeg = projectFolderSegment(opts.newProjectName);
  const current = path.resolve(opts.currentLocalPath.trim());
  if (!opts.currentLocalPath.trim() || oldSeg === newSeg) {
    return { localPath: current, renamed: false };
  }

  const oldDefault = path.resolve(
    defaultLocalPath(opts.username, opts.oldProjectName),
  );
  const newDefault = path.resolve(
    defaultLocalPath(opts.username, opts.newProjectName),
  );

  let oldParent: string | null = null;
  let newParent: string | null = null;
  let newLocal: string | null = null;

  if (current === oldDefault) {
    oldParent = path.dirname(oldDefault);
    newParent = path.dirname(newDefault);
    newLocal = newDefault;
  } else {
    const parts = current.split(path.sep);
    const srcIdx = parts.lastIndexOf("source");
    if (srcIdx > 0 && parts[srcIdx - 1] === oldSeg) {
      parts[srcIdx - 1] = newSeg;
      newLocal = parts.join(path.sep);
      oldParent = path.dirname(current);
      newParent = path.dirname(newLocal);
    }
  }

  if (!oldParent || !newParent || !newLocal) {
    return { localPath: current, renamed: false };
  }

  if (await pathExists(newParent)) {
    throw new Error(`Destination folder already exists: ${newParent}`);
  }

  if (await pathExists(oldParent)) {
    await fsRename(oldParent, newParent);
    logger.info("Renamed project folder", {
      from: oldParent,
      to: newParent,
    });
    return { localPath: newLocal, renamed: true };
  }

  // No folder yet — just point metadata at the new default path
  return { localPath: newLocal, renamed: false };
}

export async function activateProject(
  username: string,
  projectId: string,
): Promise<WorkspaceProject> {
  const project = await getProject(projectId);
  if (!project) throw new Error(`Project not found: ${projectId}`);
  if (project.userId !== normUserId(username)) {
    throw new Error("Not your project");
  }
  return updateProjectFields(projectId, { isActive: true });
}

export async function deleteUserProject(
  username: string,
  projectId: string,
): Promise<void> {
  const project = await getProject(projectId);
  if (!project) throw new Error(`Project not found: ${projectId}`);
  if (project.userId !== normUserId(username)) {
    throw new Error("Not your project");
  }
  await WorkspaceProjectModel.softDeleteMany({ id: projectId });
  try {
    await WorkspaceMembershipModel.softDeleteMany({
      userId: normUserId(username),
      projectId,
    });
  } catch {
    /* legacy memberships optional */
  }
}

export async function upsertMembership(opts: {
  userId: string;
  projectId: string;
  baseBranch?: string;
  workBranch?: string;
  role?: WorkspaceMembership["role"];
}): Promise<WorkspaceMembership> {
  const userId = normUserId(opts.userId);
  const project = await getProject(opts.projectId);
  if (project && project.userId === userId) {
    const updated = await updateProjectFields(opts.projectId, {
      ...(opts.baseBranch !== undefined
        ? { mainBranch: opts.baseBranch }
        : {}),
      ...(opts.workBranch !== undefined
        ? { workingBranch: opts.workBranch }
        : {}),
    });
    return projectToMembership(userId, updated);
  }
  // Legacy membership collection
  const id = membershipId(userId, opts.projectId);
  const now = new Date().toISOString();
  const existing = await WorkspaceMembershipModel.findOne({ id });
  await WorkspaceMembershipModel.purgeSoftDeleted({ id });
  const $set: Record<string, unknown> = {
    id,
    userId,
    projectId: opts.projectId,
    role: opts.role ?? existing?.role ?? "dev",
    joinedAt: existing?.joinedAt ?? now,
    updatedAt: now,
    deleted: false,
    deletedAt: null,
  };
  const $unset: Record<string, ""> = {};
  if (opts.baseBranch !== undefined) {
    const v = opts.baseBranch.trim();
    if (v) $set.baseBranch = v;
    else $unset.baseBranch = "";
  }
  if (opts.workBranch !== undefined) {
    const v = opts.workBranch.trim();
    if (v) $set.workBranch = v;
    else $unset.workBranch = "";
  }
  const update: { $set: Record<string, unknown>; $unset?: Record<string, ""> } =
    { $set };
  if (Object.keys($unset).length) update.$unset = $unset;
  await WorkspaceMembershipModel.updateOne({ id }, update, {
    upsert: true,
    raw: true,
  });
  const saved = await WorkspaceMembershipModel.findOne({ id });
  if (!saved) throw new Error("Failed to save membership");
  return saved;
}

export async function listMembershipsForUser(
  username: string,
): Promise<MembershipWithProject[]> {
  const projects = await listProjectsForUser(username);
  if (projects.length) {
    return projects.map((p) => projectToMembership(username, p));
  }
  // Legacy fallback
  const userId = normUserId(username);
  const mems = await WorkspaceMembershipModel.findMany({
    filter: { userId },
    sort: { updatedAt: -1 },
  });
  const out: MembershipWithProject[] = [];
  for (const m of mems) {
    const project = await getProject(m.projectId);
    if (project) out.push({ ...m, project });
  }
  return out;
}

export async function getMembership(
  username: string,
  projectId: string,
): Promise<WorkspaceMembership | null> {
  const project = await getProject(projectId);
  if (project && project.userId === normUserId(username)) {
    return projectToMembership(username, project);
  }
  const id = membershipId(normUserId(username), projectId);
  return WorkspaceMembershipModel.findOne({ id });
}

/** Admin: list all users including disabled (soft-deleted). */
export async function listUsersForAdmin(): Promise<AdminUserPublic[]> {
  const docs = await WorkspaceUserModel.findMany({
    withDeleted: true,
    sort: { updatedAt: -1 },
  });
  return docs.map((d) => toAdminUser(d));
}

export async function getUserForAdmin(
  username: string,
): Promise<AdminUserPublic | null> {
  const id = normUserId(username);
  const doc = await WorkspaceUserModel.findById(id, { withDeleted: true });
  if (!doc) return null;
  return toAdminUser(doc);
}

export async function adminCreateUser(opts: {
  username: string;
  password: string;
  displayName?: string;
  roles?: UserRole[];
}): Promise<AdminUserPublic> {
  const id = normUserId(opts.username);
  if (!id) throw new Error("username required");
  const existing = await WorkspaceUserModel.findById(id, { withDeleted: true });
  if (existing && !existing.deleted) {
    throw new Error("Username already exists");
  }
  await createOrUpdateUserPassword({
    username: opts.username,
    password: opts.password,
    displayName: opts.displayName,
    roles: opts.roles,
  });
  const row = await getUserForAdmin(id);
  if (!row) throw new Error("Failed to create user");
  return row;
}

export async function adminUpdateUser(opts: {
  username: string;
  displayName?: string;
  roles?: UserRole[];
}): Promise<AdminUserPublic> {
  const id = normUserId(opts.username);
  if (isRootAdminUsername(id)) {
    throw new Error("Root admin account is protected");
  }
  const existing = await WorkspaceUserModel.findById(id, { withDeleted: true });
  if (!existing) throw new Error("User not found");
  const now = new Date().toISOString();
  const $set: Record<string, unknown> = { updatedAt: now };
  if (opts.displayName !== undefined) {
    $set.displayName = opts.displayName.trim() || undefined;
  }
  if (opts.roles !== undefined) {
    $set.roles = normalizeUserRoles(opts.roles);
  }
  await WorkspaceUserModel.updateOne({ id }, { $set }, { raw: true });
  const updated = await getUserForAdmin(id);
  if (!updated) throw new Error("User not found");
  return updated;
}

export async function adminSetUserDisabled(
  username: string,
  disabled: boolean,
): Promise<AdminUserPublic> {
  const id = normUserId(username);
  if (isRootAdminUsername(id)) {
    throw new Error("Root admin account is protected");
  }
  const existing = await WorkspaceUserModel.findById(id, { withDeleted: true });
  if (!existing) throw new Error("User not found");
  if (disabled) {
    const ok = await WorkspaceUserModel.softDeleteById(id);
    if (!ok) throw new Error("Failed to disable user");
  } else {
    await WorkspaceUserModel.updateOne(
      { id },
      {
        $set: {
          deleted: false,
          deletedAt: null,
          updatedAt: new Date().toISOString(),
        },
      },
      { raw: true },
    );
  }
  const updated = await getUserForAdmin(id);
  if (!updated) throw new Error("User not found");
  return updated;
}

export async function adminPurgeUser(username: string): Promise<{ ok: true }> {
  const id = normUserId(username);
  if (isRootAdminUsername(id)) {
    throw new Error("Root admin account is protected");
  }
  const existing = await WorkspaceUserModel.findById(id, { withDeleted: true });
  if (!existing) throw new Error("User not found");
  if (!existing.deleted) {
    await WorkspaceUserModel.softDeleteById(id);
  }
  const n = await WorkspaceUserModel.purgeSoftDeleted({ id });
  if (n < 1) {
    await WorkspaceUserModel.forceDeleteById(id);
  }
  return { ok: true };
}

export async function adminResetUserPassword(opts: {
  username: string;
  newPassword: string;
}): Promise<AdminUserPublic> {
  const id = normUserId(opts.username);
  if (isRootAdminUsername(id)) {
    throw new Error("Root admin account is protected");
  }
  const existing = await WorkspaceUserModel.findById(id, { withDeleted: true });
  if (!existing) throw new Error("User not found");
  if (existing.deleted) {
    throw new Error("Cannot reset password for disabled user");
  }
  const newPassword = opts.newPassword.trim();
  if (newPassword.length < 6) {
    throw new Error("Password must be at least 6 characters");
  }
  const passwordHash = await hashPassword(newPassword);
  const now = new Date().toISOString();
  await WorkspaceUserModel.updateOne(
    { id },
    { $set: { passwordHash, updatedAt: now } },
    { raw: true },
  );
  const updated = await getUserForAdmin(id);
  if (!updated) throw new Error("User not found");
  return updated;
}
