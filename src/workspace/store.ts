import { type Collection } from "mongodb";
import { connectMongo } from "../db/mongo.js";
import { decryptSecret, encryptSecret } from "../crypto/secrets.js";
import {
  membershipId,
  projectIdFromPath,
  toPublicUser,
  type MembershipWithProject,
  type WorkspaceMembership,
  type WorkspaceProject,
  type WorkspaceUser,
  type WorkspaceUserPublic,
} from "./types.js";

async function usersCol(): Promise<Collection<WorkspaceUser>> {
  const db = await connectMongo();
  return db.collection<WorkspaceUser>("workspace_users");
}

async function projectsCol(): Promise<Collection<WorkspaceProject>> {
  const db = await connectMongo();
  return db.collection<WorkspaceProject>("workspace_projects");
}

async function membershipsCol(): Promise<Collection<WorkspaceMembership>> {
  const db = await connectMongo();
  return db.collection<WorkspaceMembership>("workspace_memberships");
}

export async function ensureWorkspaceIndexes(): Promise<void> {
  const db = await connectMongo();
  await db.collection("workspace_users").createIndex({ gitlabUsername: 1 }, { unique: true });
  await db.collection("workspace_projects").createIndex({ gitlabPath: 1 }, { unique: true });
  await db
    .collection("workspace_memberships")
    .createIndex({ userId: 1, projectId: 1 }, { unique: true });
}

function normUsername(username: string): string {
  return username.trim().replace(/^@/, "").toLowerCase();
}

export async function getUserByUsername(
  username: string,
): Promise<WorkspaceUser | null> {
  const id = normUsername(username);
  if (!id) return null;
  return (await usersCol()).findOne({ id });
}

export async function upsertUserLogin(opts: {
  gitlabUsername: string;
  displayName?: string;
  gitlabToken?: string;
  cursorApiKey?: string;
  cursorModel?: string;
}): Promise<WorkspaceUserPublic> {
  const id = normUsername(opts.gitlabUsername);
  if (!id) throw new Error("gitlabUsername required");
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
  if (opts.cursorApiKey?.trim()) {
    doc.cursorApiKeyEnc = encryptSecret(opts.cursorApiKey);
  }
  if (opts.cursorModel !== undefined) {
    const m = opts.cursorModel.trim() || "auto";
    doc.cursorModel = m;
  } else if (!doc.cursorModel) {
    doc.cursorModel = "auto";
  }
  doc.updatedAt = now;
  if (!existing) {
    doc.gitlabUsername = opts.gitlabUsername.trim().replace(/^@/, "");
  }
  await (await usersCol()).updateOne(
    { id },
    { $set: doc },
    { upsert: true },
  );
  return toPublicUser(doc);
}

/** Update non-secret preferences (e.g. Cursor model). */
export async function updateUserPreferences(opts: {
  gitlabUsername: string;
  cursorModel?: string;
}): Promise<WorkspaceUserPublic> {
  const id = normUsername(opts.gitlabUsername);
  const existing = await getUserByUsername(id);
  if (!existing) throw new Error("User not found");
  const now = new Date().toISOString();
  if (opts.cursorModel !== undefined) {
    existing.cursorModel = opts.cursorModel.trim() || "auto";
  }
  existing.updatedAt = now;
  await (await usersCol()).updateOne({ id }, { $set: existing });
  return toPublicUser(existing);
}

/** Remove stored Cursor API key (encrypted field). */
export async function clearCursorApiKey(
  username: string,
): Promise<WorkspaceUserPublic> {
  const id = normUsername(username);
  const existing = await getUserByUsername(id);
  if (!existing) throw new Error("User not found");
  const now = new Date().toISOString();
  await (await usersCol()).updateOne(
    { id },
    { $unset: { cursorApiKeyEnc: "" }, $set: { updatedAt: now } },
  );
  const updated = await getUserByUsername(id);
  if (!updated) throw new Error("User not found after clear");
  return toPublicUser(updated);
}

export async function getUserSecrets(username: string): Promise<{
  gitlabToken: string;
  cursorApiKey?: string;
} | null> {
  const user = await getUserByUsername(username);
  if (!user?.gitlabTokenEnc) return null;
  return {
    gitlabToken: decryptSecret(user.gitlabTokenEnc),
    cursorApiKey: user.cursorApiKeyEnc
      ? decryptSecret(user.cursorApiKeyEnc)
      : undefined,
  };
}

export async function listProjects(): Promise<WorkspaceProject[]> {
  return (await projectsCol()).find({}).sort({ displayName: 1 }).toArray();
}

export async function getProject(projectId: string): Promise<WorkspaceProject | null> {
  return (await projectsCol()).findOne({ id: projectId });
}

export async function getProjectByPath(
  gitlabPath: string,
): Promise<WorkspaceProject | null> {
  const path = gitlabPath.trim().replace(/^\/+|\/+$/g, "");
  return (await projectsCol()).findOne({
    gitlabPath: { $regex: `^${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, $options: "i" },
  });
}

export async function upsertProject(opts: {
  gitlabPath: string;
  repoPath: string;
  displayName?: string;
  gitlabProjectId?: number;
  createdByUsername: string;
}): Promise<WorkspaceProject> {
  const gitlabPath = opts.gitlabPath.trim().replace(/^\/+|\/+$/g, "");
  if (!gitlabPath.includes("/")) {
    throw new Error("gitlabPath must look like group/project");
  }
  const id = projectIdFromPath(gitlabPath);
  const now = new Date().toISOString();
  const existing = await getProject(id);
  const doc: WorkspaceProject = {
    id,
    gitlabPath,
    displayName: opts.displayName?.trim() || existing?.displayName || gitlabPath,
    repoPath: opts.repoPath.trim(),
    gitlabProjectId: opts.gitlabProjectId ?? existing?.gitlabProjectId,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    createdByUsername: existing?.createdByUsername ?? opts.createdByUsername,
  };
  await (await projectsCol()).updateOne({ id }, { $set: doc }, { upsert: true });
  return doc;
}

export async function upsertMembership(opts: {
  userId: string;
  projectId: string;
  baseBranch?: string;
  workBranch?: string;
  role?: WorkspaceMembership["role"];
}): Promise<WorkspaceMembership> {
  const userId = normUsername(opts.userId);
  const id = membershipId(userId, opts.projectId);
  const now = new Date().toISOString();
  const col = await membershipsCol();
  const existing = await col.findOne({ id });

  const $set: Record<string, unknown> = {
    id,
    userId,
    projectId: opts.projectId,
    role: opts.role ?? existing?.role ?? "dev",
    joinedAt: existing?.joinedAt ?? now,
    updatedAt: now,
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

  await col.updateOne({ id }, update, { upsert: true });
  const saved = await col.findOne({ id });
  if (!saved) throw new Error("Failed to save membership");
  return saved;
}

export async function listMembershipsForUser(
  username: string,
): Promise<MembershipWithProject[]> {
  const userId = normUsername(username);
  const mems = await (await membershipsCol())
    .find({ userId })
    .sort({ updatedAt: -1 })
    .toArray();
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
  const id = membershipId(normUsername(username), projectId);
  return (await membershipsCol()).findOne({ id });
}
