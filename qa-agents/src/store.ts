import { connectMongo } from "../../src/db/mongo.js";
import {
  decryptSecret,
  encryptSecret,
} from "../../src/plugins/crypto/secrets.js";
import {
  DEFAULT_QA_PROJECT_CONFIG,
  type QaAccountPreset,
  type QaAccountPresetPublic,
  type QaProjectConfig,
} from "./types.js";

function configs() {
  return connectMongo().then((db) =>
    db.collection<QaProjectConfig>("qa_project_configs"),
  );
}

function presets() {
  return connectMongo().then((db) =>
    db.collection<QaAccountPreset>("qa_account_presets"),
  );
}

export async function ensureQaIndexes(): Promise<void> {
  const cfg = await configs();
  await cfg.createIndex({ workspaceProjectId: 1 }, { unique: true });
  const p = await presets();
  await p.createIndex({ workspaceProjectId: 1, role: 1 });
  await p.createIndex({ id: 1 }, { unique: true });
}

export async function getQaProjectConfig(
  workspaceProjectId: string,
): Promise<QaProjectConfig | null> {
  const col = await configs();
  return col.findOne({ workspaceProjectId });
}

export async function upsertQaProjectConfig(
  workspaceProjectId: string,
  patch: Partial<
    Omit<QaProjectConfig, "workspaceProjectId" | "createdAt" | "updatedAt">
  >,
): Promise<QaProjectConfig> {
  const col = await configs();
  const now = new Date().toISOString();
  const existing = await col.findOne({ workspaceProjectId });
  const next: QaProjectConfig = {
    workspaceProjectId,
    stagingBaseUrl:
      patch.stagingBaseUrl?.trim() || existing?.stagingBaseUrl || "",
    loginPath:
      patch.loginPath?.trim() ||
      existing?.loginPath ||
      DEFAULT_QA_PROJECT_CONFIG.loginPath,
    requestBodyKeys: {
      username:
        patch.requestBodyKeys?.username?.trim() ||
        existing?.requestBodyKeys?.username ||
        DEFAULT_QA_PROJECT_CONFIG.requestBodyKeys.username,
      password:
        patch.requestBodyKeys?.password?.trim() ||
        existing?.requestBodyKeys?.password ||
        DEFAULT_QA_PROJECT_CONFIG.requestBodyKeys.password,
    },
    tokenJsonPath:
      patch.tokenJsonPath?.trim() ||
      existing?.tokenJsonPath ||
      DEFAULT_QA_PROJECT_CONFIG.tokenJsonPath,
    localStorageTokenKey:
      patch.localStorageTokenKey?.trim() ||
      existing?.localStorageTokenKey ||
      DEFAULT_QA_PROJECT_CONFIG.localStorageTokenKey,
    maxActions:
      patch.maxActions ??
      existing?.maxActions ??
      DEFAULT_QA_PROJECT_CONFIG.maxActions,
    actionTimeoutSec:
      patch.actionTimeoutSec ??
      existing?.actionTimeoutSec ??
      DEFAULT_QA_PROJECT_CONFIG.actionTimeoutSec,
    maxConcurrentSessions:
      patch.maxConcurrentSessions ??
      existing?.maxConcurrentSessions ??
      DEFAULT_QA_PROJECT_CONFIG.maxConcurrentSessions,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  await col.updateOne({ workspaceProjectId }, { $set: next }, { upsert: true });
  return next;
}

function toPublic(p: QaAccountPreset): QaAccountPresetPublic {
  return {
    id: p.id,
    workspaceProjectId: p.workspaceProjectId,
    role: p.role,
    username: p.username,
    lastUsedAt: p.lastUsedAt,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

export async function listQaPresets(
  workspaceProjectId: string,
): Promise<QaAccountPresetPublic[]> {
  const col = await presets();
  const docs = await col
    .find({ workspaceProjectId })
    .sort({ role: 1 })
    .toArray();
  return docs.map(toPublic);
}

export async function createQaPreset(input: {
  workspaceProjectId: string;
  role: string;
  username: string;
  password: string;
}): Promise<QaAccountPresetPublic> {
  const role = input.role.trim();
  const username = input.username.trim();
  const password = input.password.trim();
  if (!role || !username || !password) {
    throw new Error("role, username, and password are required");
  }
  const now = new Date().toISOString();
  const doc: QaAccountPreset = {
    id: `preset-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`,
    workspaceProjectId: input.workspaceProjectId,
    role,
    username,
    passwordEnc: encryptSecret(password),
    createdAt: now,
    updatedAt: now,
  };
  const col = await presets();
  await col.insertOne(doc);
  return toPublic(doc);
}

export async function updateQaPreset(
  id: string,
  workspaceProjectId: string,
  patch: { role?: string; username?: string; password?: string },
): Promise<QaAccountPresetPublic | null> {
  const col = await presets();
  const existing = await col.findOne({ id, workspaceProjectId });
  if (!existing) return null;
  const next: QaAccountPreset = {
    ...existing,
    role: patch.role?.trim() || existing.role,
    username: patch.username?.trim() || existing.username,
    passwordEnc: patch.password?.trim()
      ? encryptSecret(patch.password.trim())
      : existing.passwordEnc,
    updatedAt: new Date().toISOString(),
  };
  await col.replaceOne({ id }, next);
  return toPublic(next);
}

export async function deleteQaPreset(
  id: string,
  workspaceProjectId: string,
): Promise<boolean> {
  const col = await presets();
  const res = await col.deleteOne({ id, workspaceProjectId });
  return res.deletedCount > 0;
}

export async function resolveQaPresetCredentials(
  id: string,
  workspaceProjectId: string,
): Promise<{ username: string; password: string; role: string } | null> {
  const col = await presets();
  const doc = await col.findOne({ id, workspaceProjectId });
  if (!doc) return null;
  await col.updateOne(
    { id },
    { $set: { lastUsedAt: new Date().toISOString() } },
  );
  return {
    username: doc.username,
    password: decryptSecret(doc.passwordEnc),
    role: doc.role,
  };
}
