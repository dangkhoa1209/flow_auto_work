import crypto from "node:crypto";
import {
  BaMessageModel,
  BaProjectModel,
  BaRequirementModel,
  BaTaskDraftModel,
  BaThreadModel,
  SystemSettingsModel,
} from "../models/ba.js";
import { decryptSecret, encryptSecret } from "../plugins/crypto/secrets.js";
import {
  baProjectLocalPath,
  normalizeGitlabHost,
  type CloneStatus,
} from "./types.js";

export type BaDbDialect = "mysql" | "postgres" | "mongodb";

/** Encrypted-at-rest DB connection for BA read-only queries. */
export type BaDbConnection = {
  enabled: boolean;
  dialect: BaDbDialect;
  host: string;
  port: number;
  database: string;
  username: string;
  /** AES-GCM ciphertext via encryptSecret — never return to clients. Optional for MongoDB without auth. */
  passwordEnc?: string;
  ssl?: boolean;
  updatedAt: string;
};

export type BaDbConnectionPublic = {
  configured: boolean;
  enabled: boolean;
  dialect: BaDbDialect | null;
  host: string | null;
  port: number | null;
  database: string | null;
  username: string | null;
  ssl: boolean;
  updatedAt: string | null;
};

/** Decrypted runtime config — in-memory only, never persist. */
export type BaDbConnectionResolved = {
  dialect: BaDbDialect;
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  ssl: boolean;
};

export type BaProject = {
  id: string;
  slug: string;
  displayName: string;
  gitlabHost: string;
  gitlabPath: string;
  gitlabTokenEnc?: string;
  localPath: string;
  mainBranch?: string;
  cloneStatus: CloneStatus;
  cloneError?: string | null;
  db?: BaDbConnection | null;
  createdAt: string;
  updatedAt: string;
};

export type BaProjectPublic = {
  id: string;
  slug: string;
  displayName: string;
  gitlabHost: string;
  gitlabPath: string;
  localPath: string;
  mainBranch: string | null;
  cloneStatus: CloneStatus;
  cloneError: string | null;
  hasGitlabToken: boolean;
  db: BaDbConnectionPublic;
  createdAt: string;
  updatedAt: string;
};

export type TaskTypeLabelMapping = {
  bug: string[];
  feature: string[];
  refactor: string[];
  chore: string[];
};

/**
 * Trạng thái phát hành từng tính năng BA:
 * - hide: ẩn hoàn toàn với người dùng
 * - lab: hiện kèm nhãn "(lab)" — đang thử nghiệm
 * - production: hiện bình thường
 */
export type BaFeatureState = "hide" | "lab" | "production";

export type BaFeatureKey = "createIssue" | "workflow" | "tasks";

export type BaFeatureFlags = Record<BaFeatureKey, BaFeatureState>;

export type BaFeatureSettings = {
  flags: BaFeatureFlags;
  /** Tên hiển thị tab workflow (mặc định "Phân tích YC") — admin đổi được. */
  workflowTabLabel: string;
};

export type BaFeatureSettingsEffective = BaFeatureSettings & {
  /** DEV=true / PRODUCTION=false — mở hết tính năng cho dev. */
  devMode: boolean;
};

export type SystemSettings = {
  id: "default";
  cursorApiKeyEnc?: string;
  cursorModel?: string;
  taskTypeLabels?: TaskTypeLabelMapping;
  taskTypeLabelsUpdatedAt?: string;
  baFeatures?: Partial<BaFeatureFlags> & { workflowTabLabel?: string };
  baFeaturesUpdatedAt?: string;
  updatedAt: string;
};

export type SystemSettingsPublic = {
  hasCursorApiKey: boolean;
  cursorModel: string;
  taskTypeLabels: TaskTypeLabelMapping;
  taskTypeLabelsUpdatedAt: string | null;
  baFeatures: BaFeatureSettings;
  baFeaturesUpdatedAt: string | null;
  updatedAt: string;
};

export type BaDbConnectionPatch = {
  enabled?: boolean;
  dialect?: BaDbDialect;
  host?: string;
  port?: number;
  database?: string;
  username?: string;
  /** New password; empty/undefined keeps existing. */
  password?: string;
  ssl?: boolean;
  /** Remove entire DB config. */
  clear?: boolean;
};

const DEFAULT_PORTS: Record<BaDbDialect, number> = {
  mysql: 3306,
  postgres: 5432,
  mongodb: 27017,
};

export async function ensureBaIndexes(): Promise<void> {
  await BaProjectModel.ensureIndexes();
  await BaThreadModel.ensureIndexes();
  await BaMessageModel.ensureIndexes();
  await BaRequirementModel.ensureIndexes();
  await BaTaskDraftModel.ensureIndexes();
  await SystemSettingsModel.ensureIndexes();
}

function slugify(raw: string): string {
  return (
    raw
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || "project"
  );
}

export function toPublicBaDb(db: BaDbConnection | null | undefined): BaDbConnectionPublic {
  if (!db?.host || !db?.database) {
    return {
      configured: false,
      enabled: false,
      dialect: null,
      host: null,
      port: null,
      database: null,
      username: null,
      ssl: false,
      updatedAt: null,
    };
  }
  const configured = Boolean(
    db.passwordEnc || db.dialect === "mongodb",
  );
  if (!configured) {
    return {
      configured: false,
      enabled: false,
      dialect: db.dialect,
      host: db.host || null,
      port: db.port ?? null,
      database: db.database || null,
      username: db.username || null,
      ssl: Boolean(db.ssl),
      updatedAt: db.updatedAt || null,
    };
  }
  return {
    configured: true,
    enabled: Boolean(db.enabled),
    dialect: db.dialect,
    host: db.host || null,
    port: db.port ?? null,
    database: db.database || null,
    username: db.username || null,
    ssl: Boolean(db.ssl),
    updatedAt: db.updatedAt || null,
  };
}

/** True when admin enabled DB and credentials exist. */
export function isBaDbAccessAllowed(
  project: BaProject | null | undefined,
): boolean {
  if (!project?.db?.enabled || !project.db.host || !project.db.database) {
    return false;
  }
  if (project.db.dialect === "mongodb") return true;
  return Boolean(project.db.passwordEnc);
}

export function toPublicBaProject(p: BaProject): BaProjectPublic {
  return {
    id: p.id,
    slug: p.slug,
    displayName: p.displayName,
    gitlabHost: p.gitlabHost,
    gitlabPath: p.gitlabPath,
    localPath: p.localPath,
    mainBranch: p.mainBranch ?? null,
    cloneStatus: p.cloneStatus,
    cloneError: p.cloneError ?? null,
    hasGitlabToken: Boolean(p.gitlabTokenEnc),
    db: toPublicBaDb(p.db),
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

export async function listBaProjects(): Promise<BaProject[]> {
  return BaProjectModel.findMany({ sort: { displayName: 1 } });
}

export async function getBaProject(id: string): Promise<BaProject | null> {
  return BaProjectModel.findOne({ id: id.trim() });
}

export async function createBaProject(opts: {
  slug?: string;
  displayName: string;
  gitlabPath: string;
  gitlabHost?: string;
  gitlabToken?: string;
  mainBranch?: string;
  localPath?: string;
}): Promise<BaProject> {
  const displayName = opts.displayName.trim();
  const gitlabPath = opts.gitlabPath.trim().replace(/^\/+|\/+$/g, "");
  if (!displayName || !gitlabPath) {
    throw new Error("displayName and gitlabPath required");
  }
  const slug = slugify(opts.slug || displayName);
  const now = new Date().toISOString();
  const id = `ba_${slug}`;
  const existing = await getBaProject(id);
  if (existing) throw new Error(`BA project already exists: ${slug}`);

  const doc: BaProject = {
    id,
    slug,
    displayName,
    gitlabHost: normalizeGitlabHost(opts.gitlabHost),
    gitlabPath,
    localPath: opts.localPath?.trim() || baProjectLocalPath(slug),
    mainBranch: opts.mainBranch?.trim() || "main",
    cloneStatus: "pending",
    cloneError: null,
    createdAt: now,
    updatedAt: now,
  };
  if (opts.gitlabToken?.trim()) {
    doc.gitlabTokenEnc = encryptSecret(opts.gitlabToken.trim());
  }
  await BaProjectModel.purgeSoftDeleted({ id });
  await BaProjectModel.insert(doc);
  return doc;
}

function normalizeDialect(raw: string | undefined): BaDbDialect {
  const d = (raw || "").trim().toLowerCase();
  if (d === "postgres" || d === "postgresql" || d === "pg") return "postgres";
  if (d === "mysql" || d === "mariadb") return "mysql";
  if (d === "mongodb" || d === "mongo") return "mongodb";
  throw new Error("db.dialect must be mysql, postgres, or mongodb");
}

function applyDbPatch(
  existing: BaDbConnection | null | undefined,
  patch: BaDbConnectionPatch,
): BaDbConnection | null {
  if (patch.clear) return null;

  const dialect = patch.dialect
    ? normalizeDialect(patch.dialect)
    : existing?.dialect || "mysql";
  const host = (patch.host !== undefined ? patch.host : existing?.host || "")
    .trim();
  const database = (
    patch.database !== undefined ? patch.database : existing?.database || ""
  ).trim();
  const username = (
    patch.username !== undefined ? patch.username : existing?.username || ""
  ).trim();
  const portRaw =
    patch.port !== undefined ? Number(patch.port) : existing?.port;
  const port =
    Number.isFinite(portRaw) && (portRaw as number) > 0
      ? Math.floor(portRaw as number)
      : DEFAULT_PORTS[dialect];
  const ssl =
    patch.ssl !== undefined ? Boolean(patch.ssl) : Boolean(existing?.ssl);
  const enabled =
    patch.enabled !== undefined
      ? Boolean(patch.enabled)
      : Boolean(existing?.enabled);

  let passwordEnc = existing?.passwordEnc || "";
  if (patch.password !== undefined && patch.password !== "") {
    passwordEnc = encryptSecret(patch.password);
  }

  if (!host || !database) {
    throw new Error("DB host and database required");
  }
  if (dialect !== "mongodb") {
    if (!passwordEnc) throw new Error("DB password required");
    if (!username) throw new Error("DB username required");
  }

  const doc: BaDbConnection = {
    enabled,
    dialect,
    host,
    port,
    database,
    username,
    ssl,
    updatedAt: new Date().toISOString(),
  };
  if (passwordEnc) doc.passwordEnc = passwordEnc;
  return doc;
}

export async function updateBaProject(
  id: string,
  patch: {
    displayName?: string;
    gitlabPath?: string;
    gitlabHost?: string;
    gitlabToken?: string;
    mainBranch?: string;
    localPath?: string;
    cloneStatus?: CloneStatus;
    cloneError?: string | null;
    db?: BaDbConnectionPatch;
  },
): Promise<BaProject> {
  const existing = await getBaProject(id);
  if (!existing) throw new Error("BA project not found");
  const now = new Date().toISOString();
  if (patch.displayName?.trim()) existing.displayName = patch.displayName.trim();
  if (patch.gitlabPath?.trim()) {
    existing.gitlabPath = patch.gitlabPath.trim().replace(/^\/+|\/+$/g, "");
  }
  if (patch.gitlabHost !== undefined) {
    existing.gitlabHost = normalizeGitlabHost(patch.gitlabHost);
  }
  if (patch.gitlabToken?.trim()) {
    existing.gitlabTokenEnc = encryptSecret(patch.gitlabToken.trim());
  }
  if (patch.mainBranch !== undefined) {
    existing.mainBranch = patch.mainBranch.trim() || "main";
  }
  if (patch.localPath?.trim()) existing.localPath = patch.localPath.trim();
  if (patch.cloneStatus !== undefined) existing.cloneStatus = patch.cloneStatus;
  if (patch.cloneError !== undefined) existing.cloneError = patch.cloneError;

  if (patch.db !== undefined) {
    const next = applyDbPatch(existing.db, patch.db);
    if (next === null) {
      existing.db = null;
    } else {
      existing.db = next;
    }
  }

  existing.updatedAt = now;
  await BaProjectModel.updateOne({ id }, { $set: existing });
  return existing;
}

export async function deleteBaProject(id: string): Promise<boolean> {
  const n = await BaProjectModel.softDeleteMany({ id: id.trim() });
  const res = { deletedCount: n };
  return res.deletedCount > 0;
}

export async function getBaProjectGitlabToken(
  id: string,
): Promise<string | null> {
  const p = await getBaProject(id);
  if (!p?.gitlabTokenEnc) return null;
  return decryptSecret(p.gitlabTokenEnc);
}

/**
 * Decrypt DB credentials when access is allowed (enabled + configured).
 * Returns null if inactive / missing.
 */
export async function resolveBaProjectDb(
  id: string,
): Promise<BaDbConnectionResolved | null> {
  const p = await getBaProject(id);
  if (!isBaDbAccessAllowed(p) || !p?.db) return null;
  const password = p.db.passwordEnc ? decryptSecret(p.db.passwordEnc) : "";
  return {
    dialect: p.db.dialect,
    host: p.db.host,
    port: p.db.port,
    database: p.db.database,
    username: p.db.username,
    password,
    ssl: Boolean(p.db.ssl),
  };
}

/** Decrypt for admin test even when disabled (must be configured). */
export async function resolveBaProjectDbForTest(
  id: string,
): Promise<BaDbConnectionResolved | null> {
  const p = await getBaProject(id);
  if (!p?.db?.host || !p.db.database) return null;
  if (p.db.dialect !== "mongodb" && !p.db.passwordEnc) return null;
  return {
    dialect: p.db.dialect,
    host: p.db.host,
    port: p.db.port,
    database: p.db.database,
    username: p.db.username,
    password: p.db.passwordEnc ? decryptSecret(p.db.passwordEnc) : "",
    ssl: Boolean(p.db.ssl),
  };
}

export async function getSystemSettings(): Promise<SystemSettings> {
  const existing = await SystemSettingsModel.findOne({ id: "default" });
  if (existing) return existing;
  const doc: SystemSettings = {
    id: "default",
    cursorModel: "auto",
    updatedAt: new Date().toISOString(),
  };
  await SystemSettingsModel.purgeSoftDeleted({ id: "default" });
  return SystemSettingsModel.upsertOne({ id: "default" }, doc);
}

function defaultTaskTypeLabels(): TaskTypeLabelMapping {
  return {
    bug: ["bug", "fix", "hotfix", "defect"],
    feature: ["feature", "enhancement", "story"],
    refactor: ["refactor", "cleanup"],
    chore: ["chore", "maintenance", "ci", "docs"],
  };
}

function normalizeTaskTypeLabels(
  raw?: Partial<TaskTypeLabelMapping> | null,
): TaskTypeLabelMapping {
  const d = defaultTaskTypeLabels();
  const clean = (xs: string[] | undefined, fallback: string[]) => {
    const out = (xs ?? fallback)
      .map((s) => String(s).trim())
      .filter(Boolean);
    return out.length ? [...new Set(out)] : fallback;
  };
  return {
    bug: clean(raw?.bug, d.bug),
    feature: clean(raw?.feature, d.feature),
    refactor: clean(raw?.refactor, d.refactor),
    chore: clean(raw?.chore, d.chore),
  };
}

export const BA_FEATURE_KEYS: BaFeatureKey[] = [
  "createIssue",
  "workflow",
  "tasks",
];

export const DEFAULT_BA_WORKFLOW_TAB_LABEL = "Phân tích YC";

function normalizeBaFeatureState(raw: unknown): BaFeatureState {
  return raw === "lab" || raw === "production" ? raw : "hide";
}

/** Chưa production: mặc định ẩn — chỉ chat + BA mode là mặc định mở. */
export function normalizeBaFeatures(
  raw?: SystemSettings["baFeatures"] | null,
): BaFeatureSettings {
  return {
    flags: {
      createIssue: normalizeBaFeatureState(raw?.createIssue),
      workflow: normalizeBaFeatureState(raw?.workflow),
      tasks: normalizeBaFeatureState(raw?.tasks),
    },
    workflowTabLabel:
      (raw?.workflowTabLabel ?? "").trim() || DEFAULT_BA_WORKFLOW_TAB_LABEL,
  };
}

/** DEV=true hoặc PRODUCTION=false → mở hết tính năng cho dev. */
export function isBaDevMode(): boolean {
  const dev = (process.env.DEV ?? "").trim().toLowerCase();
  const prod = (process.env.PRODUCTION ?? "").trim().toLowerCase();
  return dev === "true" || dev === "1" || prod === "false" || prod === "0";
}

/** Flags hiệu lực cho người dùng cuối (dev mode override tất cả thành production). */
export async function getEffectiveBaFeatures(): Promise<BaFeatureSettingsEffective> {
  const s = await getSystemSettings();
  const base = normalizeBaFeatures(s.baFeatures);
  const devMode = isBaDevMode();
  if (!devMode) return { ...base, devMode };
  return {
    flags: { createIssue: "production", workflow: "production", tasks: "production" },
    workflowTabLabel: base.workflowTabLabel,
    devMode,
  };
}

export async function updateSystemBaFeatures(
  patch: Partial<BaFeatureFlags> & { workflowTabLabel?: string },
): Promise<SystemSettingsPublic> {
  const existing = await getSystemSettings();
  const now = new Date().toISOString();
  const merged = normalizeBaFeatures({
    ...(existing.baFeatures ?? {}),
    ...patch,
  });
  await SystemSettingsModel.upsertOne(
    { id: "default" },
    {
      baFeatures: {
        ...merged.flags,
        workflowTabLabel: merged.workflowTabLabel,
      },
      baFeaturesUpdatedAt: now,
      updatedAt: now,
    },
  );
  return toPublicSystemSettings(await getSystemSettings());
}

export function toPublicSystemSettings(s: SystemSettings): SystemSettingsPublic {
  return {
    hasCursorApiKey: Boolean(s.cursorApiKeyEnc),
    cursorModel: s.cursorModel?.trim() || "auto",
    taskTypeLabels: normalizeTaskTypeLabels(s.taskTypeLabels),
    taskTypeLabelsUpdatedAt: s.taskTypeLabelsUpdatedAt ?? null,
    baFeatures: normalizeBaFeatures(s.baFeatures),
    baFeaturesUpdatedAt: s.baFeaturesUpdatedAt ?? null,
    updatedAt: s.updatedAt,
  };
}

export async function updateSystemCursorSettings(opts: {
  cursorApiKey?: string | null;
  cursorModel?: string;
}): Promise<SystemSettings> {
  const existing = await getSystemSettings();
  const now = new Date().toISOString();
  const $set: Record<string, unknown> = { updatedAt: now };
  const $unset: Record<string, ""> = {};

  if (opts.cursorApiKey !== undefined) {
    if (opts.cursorApiKey === null || opts.cursorApiKey === "") {
      $unset.cursorApiKeyEnc = "";
      delete existing.cursorApiKeyEnc;
    } else if (opts.cursorApiKey.trim()) {
      existing.cursorApiKeyEnc = encryptSecret(opts.cursorApiKey.trim());
      $set.cursorApiKeyEnc = existing.cursorApiKeyEnc;
    }
  }
  if (opts.cursorModel !== undefined) {
    existing.cursorModel = opts.cursorModel.trim() || "auto";
    $set.cursorModel = existing.cursorModel;
  }
  existing.updatedAt = now;

  const update: Record<string, unknown> = { $set };
  if (Object.keys($unset).length) update.$unset = $unset;

  await SystemSettingsModel.updateOne({ id: "default" }, update, {
    upsert: true,
    raw: true,
  });
  return getSystemSettings();
}

export async function resolveSystemCursorApiKey(): Promise<string> {
  const s = await getSystemSettings();
  if (!s.cursorApiKeyEnc) {
    throw new Error("Shared Cursor API key not configured — ask admin");
  }
  return decryptSecret(s.cursorApiKeyEnc);
}

export async function resolveSystemCursorModel(): Promise<string> {
  const s = await getSystemSettings();
  return s.cursorModel?.trim() || "auto";
}

export async function getTaskTypeLabelMapping(): Promise<{
  labels: TaskTypeLabelMapping;
  updatedAt: string;
}> {
  const s = await getSystemSettings();
  const labels = normalizeTaskTypeLabels(s.taskTypeLabels);
  return {
    labels,
    updatedAt: s.taskTypeLabelsUpdatedAt || s.updatedAt,
  };
}

export async function updateSystemTaskTypeLabels(
  body: Partial<TaskTypeLabelMapping>,
): Promise<SystemSettingsPublic> {
  const existing = await getSystemSettings();
  const now = new Date().toISOString();
  const merged = normalizeTaskTypeLabels({
    ...(existing.taskTypeLabels ?? {}),
    ...body,
  });
  await SystemSettingsModel.upsertOne(
    { id: "default" },
    {
      taskTypeLabels: merged,
      taskTypeLabelsUpdatedAt: now,
      updatedAt: now,
    },
  );
  return toPublicSystemSettings(await getSystemSettings());
}

/* ── BA threads / messages ── */

export type BaThreadIssueDraftSnapshot = {
  title: string;
  description: string;
  labels: string[];
  acceptanceCriteria: string[];
};

export type BaThreadIssueDraftCache = {
  /** Matches BaThread.issueDraftVersion when draft was generated. */
  version: number;
  draft: BaThreadIssueDraftSnapshot;
  cachedAt: string;
};

export type BaThreadKind = "chat" | "workflow";

export type BaThread = {
  id: string;
  userId: string;
  baProjectId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  /** chat = tab Chat; workflow = chat cột phải của Phân tích YC (không hiện ở tab Chat). */
  kind?: BaThreadKind;
  /** Bumps when messages change — invalidates issue-draft cache. */
  issueDraftVersion?: number;
  /** Cached agent issue draft when issueDraftVersion unchanged. */
  issueDraftCache?: BaThreadIssueDraftCache;
};

export type BaMessageRole = "user" | "assistant" | "system";

export type BaMessage = {
  id: string;
  threadId: string;
  role: BaMessageRole;
  content: string;
  createdAt: string;
};


export async function listBaThreads(
  userId: string,
  baProjectId?: string,
): Promise<BaThread[]> {
  const uid = userId.toLowerCase();
  const filter: Record<string, unknown> = {
    userId: uid,
    kind: { $ne: "workflow" },
  };
  if (baProjectId?.trim()) filter.baProjectId = baProjectId.trim();

  // Thread workflow cũ (chưa có kind) — loại theo linkedThreadId của YC.
  const reqFilter: Record<string, unknown> = {
    userId: uid,
    linkedThreadId: { $type: "string", $ne: "" },
  };
  if (baProjectId?.trim()) reqFilter.baProjectId = baProjectId.trim();
  const linkedIds = (
    await BaRequirementModel.findMany({ filter: reqFilter })
  )
    .map((r) => r.linkedThreadId)
    .filter((id): id is string => Boolean(id));

  if (linkedIds.length) {
    filter.id = { $nin: linkedIds };
  }

  return BaThreadModel.findMany({
    filter,
    sort: { updatedAt: -1 },
  });
}

export async function getBaThread(id: string): Promise<BaThread | null> {
  return BaThreadModel.findOne({ id: id.trim() });
}

export async function createBaThread(opts: {
  userId: string;
  baProjectId: string;
  title?: string;
  kind?: BaThreadKind;
}): Promise<BaThread> {
  const now = new Date().toISOString();
  const doc: BaThread = {
    id: `bat_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
    userId: opts.userId.toLowerCase(),
    baProjectId: opts.baProjectId.trim(),
    title: (opts.title || "New chat").trim() || "New chat",
    kind: opts.kind === "workflow" ? "workflow" : "chat",
    createdAt: now,
    updatedAt: now,
  };
  await BaThreadModel.insert(doc);
  return doc;
}

export async function updateBaThreadKind(
  id: string,
  kind: BaThreadKind,
): Promise<void> {
  await BaThreadModel.updateOne(
    { id: id.trim() },
    { $set: { kind, updatedAt: new Date().toISOString() } },
  );
}

export async function updateBaThreadTitle(
  id: string,
  title: string,
): Promise<BaThread | null> {
  const now = new Date().toISOString();
  await BaThreadModel.updateOne(
    { id: id.trim() },
    { $set: { title: title.trim() || "New chat", updatedAt: now } },
  );
  return getBaThread(id);
}

export async function touchBaThread(id: string): Promise<void> {
  await BaThreadModel.updateOne(
    { id: id.trim() },
    { $set: { updatedAt: new Date().toISOString() } },
  );
}

export async function deleteBaThread(id: string, userId: string): Promise<boolean> {
  const thread = await getBaThread(id);
  if (!thread || thread.userId !== userId.toLowerCase()) return false;
  await BaMessageModel.softDeleteMany({ threadId: id });
  const n = await BaThreadModel.softDeleteMany({ id });
  const res = { deletedCount: n };
  return res.deletedCount > 0;
}

export async function listBaMessages(threadId: string): Promise<BaMessage[]> {
  return BaMessageModel.findMany({
    filter: { threadId: threadId.trim() },
    sort: { createdAt: 1 },
  });
}

/** Fingerprint of thread messages (debug / legacy). Prefer issueDraftVersion for cache. */
export function hashBaThreadMessages(messages: BaMessage[]): string {
  const payload = messages
    .filter((m) => m.content?.trim())
    .map((m) => `${m.role}:${m.id}:${m.content.trim()}`)
    .join("\n---\n");
  return crypto.createHash("sha256").update(payload, "utf8").digest("hex");
}

export function baThreadIssueDraftVersion(thread: BaThread): number {
  return thread.issueDraftVersion ?? 0;
}

export function isBaThreadIssueDraftCacheValid(
  thread: BaThread,
  cache: BaThreadIssueDraftCache | undefined,
): boolean {
  return !!(
    cache &&
    cache.version === baThreadIssueDraftVersion(thread) &&
    cache.draft?.title?.trim()
  );
}

export async function bumpBaThreadIssueDraftVersion(
  threadId: string,
): Promise<number> {
  const now = new Date().toISOString();
  const res = await BaThreadModel.findOneAndUpdate(
    { id: threadId.trim() },
    {
      $inc: { issueDraftVersion: 1 },
      $set: { updatedAt: now },
    },
  );
  return res?.issueDraftVersion ?? 1;
}

export async function setBaThreadIssueDraftCache(
  threadId: string,
  version: number,
  draft: BaThreadIssueDraftSnapshot,
): Promise<void> {
  const now = new Date().toISOString();
  await BaThreadModel.updateOne(
    { id: threadId.trim() },
    {
      $set: {
        issueDraftCache: { version, draft, cachedAt: now },
        updatedAt: now,
      },
    },
  );
}

export async function appendBaMessage(opts: {
  threadId: string;
  role: BaMessageRole;
  content: string;
  id?: string;
}): Promise<BaMessage> {
  const doc: BaMessage = {
    id: opts.id || `bam_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
    threadId: opts.threadId.trim(),
    role: opts.role,
    content: opts.content,
    createdAt: new Date().toISOString(),
  };
  await BaMessageModel.insert(doc);
  await bumpBaThreadIssueDraftVersion(opts.threadId);
  return doc;
}

export async function updateBaMessageContent(
  id: string,
  content: string,
): Promise<void> {
  const existing = await BaMessageModel.findOne({ id });
  if (!existing) return;
  await BaMessageModel.updateOne({ id }, { $set: { content } });
  await bumpBaThreadIssueDraftVersion(existing.threadId);
}

/* ── BA requirements (YC workflow) ── */

export type BaRequirementStatus =
  | "draft"
  | "analyzing"
  | "review"
  | "done";

export type BaWorkflowStepKey =
  | "clarify"
  | "asIs"
  | "toBe"
  | "breakdown";

export type BaRequirementStep = {
  key: BaWorkflowStepKey;
  content: string;
  ranAt: string;
};

export type BaRequirement = {
  id: string;
  userId: string;
  baProjectId: string;
  title: string;
  /** Yêu cầu gốc — từ khách hàng / PD, giữ nguyên văn. */
  rawContent: string;
  /** BA phân tích / đàm phán — điều chỉnh của BA so với yêu cầu gốc. */
  baNote?: string | null;
  status: BaRequirementStatus;
  steps: BaRequirementStep[];
  linkedThreadId?: string | null;
  /** Thread issueDraftVersion khi steps lần cuối được lưu — so với chat để biết stale. */
  workflowChatVersion?: number;
  /** True khi YC gốc / BA đàm phán đổi sau lần phân tích gần nhất → gợi ý "Phân tích lại". */
  inputStale?: boolean;
  createdAt: string;
  updatedAt: string;
};

export async function listBaRequirements(
  userId: string,
  baProjectId?: string,
): Promise<BaRequirement[]> {
  const filter: Record<string, string> = { userId: userId.toLowerCase() };
  if (baProjectId?.trim()) filter.baProjectId = baProjectId.trim();
  return BaRequirementModel.findMany({
    filter,
    sort: { updatedAt: -1 },
  });
}

export async function getBaRequirement(id: string): Promise<BaRequirement | null> {
  return BaRequirementModel.findOne({ id: id.trim() });
}

export async function createBaRequirement(opts: {
  userId: string;
  baProjectId: string;
  title?: string;
  rawContent: string;
  baNote?: string;
  linkedThreadId?: string;
}): Promise<BaRequirement> {
  const now = new Date().toISOString();
  const raw = opts.rawContent.trim();
  const title =
    (opts.title || raw.split("\n")[0] || "Yêu cầu mới").trim().slice(0, 120) ||
    "Yêu cầu mới";
  const doc: BaRequirement = {
    id: `bar_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
    userId: opts.userId.toLowerCase(),
    baProjectId: opts.baProjectId.trim(),
    title,
    rawContent: raw,
    baNote: opts.baNote?.trim() || null,
    status: "draft",
    steps: [],
    linkedThreadId: opts.linkedThreadId?.trim() || null,
    inputStale: false,
    createdAt: now,
    updatedAt: now,
  };
  await BaRequirementModel.insert(doc);
  return doc;
}

export async function updateBaRequirement(
  id: string,
  patch: {
    title?: string;
    rawContent?: string;
    baNote?: string | null;
    status?: BaRequirementStatus;
    steps?: BaRequirementStep[];
    linkedThreadId?: string | null;
    workflowChatVersion?: number;
    inputStale?: boolean;
  },
): Promise<BaRequirement | null> {
  const existing = await getBaRequirement(id);
  if (!existing) return null;
  const now = new Date().toISOString();
  if (patch.title !== undefined) {
    existing.title = patch.title.trim() || existing.title;
  }
  if (patch.rawContent !== undefined) {
    existing.rawContent = patch.rawContent.trim();
  }
  if (patch.baNote !== undefined) {
    existing.baNote = patch.baNote?.trim() || null;
  }
  if (patch.status !== undefined) existing.status = patch.status;
  if (patch.steps !== undefined) existing.steps = patch.steps;
  if (patch.linkedThreadId !== undefined) {
    existing.linkedThreadId = patch.linkedThreadId;
  }
  if (patch.workflowChatVersion !== undefined) {
    existing.workflowChatVersion = patch.workflowChatVersion;
  }
  if (patch.inputStale !== undefined) existing.inputStale = patch.inputStale;
  existing.updatedAt = now;
  await BaRequirementModel.updateOne({ id }, { $set: existing });
  return existing;
}

/** Requirement gắn với thread chat workflow (nếu có). */
export async function getBaRequirementByThread(
  threadId: string,
): Promise<BaRequirement | null> {
  const id = threadId.trim();
  if (!id) return null;
  return BaRequirementModel.findOne({ linkedThreadId: id });
}

export async function upsertBaRequirementStep(
  id: string,
  step: BaRequirementStep,
): Promise<BaRequirement | null> {
  const existing = await getBaRequirement(id);
  if (!existing) return null;
  const steps = existing.steps.filter((s) => s.key !== step.key);
  steps.push(step);
  steps.sort((a, b) => {
    const order: BaWorkflowStepKey[] = ["clarify", "asIs", "toBe", "breakdown"];
    return order.indexOf(a.key) - order.indexOf(b.key);
  });
  return updateBaRequirement(id, { steps, status: "review" });
}

export async function resolveWorkflowChatStale(
  requirement: BaRequirement,
): Promise<{
  threadChatVersion: number;
  stepsChatVersion: number;
  stale: boolean;
}> {
  const stepsChatVersion = requirement.workflowChatVersion ?? 0;
  const hasSteps = requirement.steps.some((s) => s.content?.trim());
  if (!hasSteps || !requirement.linkedThreadId) {
    return { threadChatVersion: 0, stepsChatVersion, stale: false };
  }
  const thread = await getBaThread(requirement.linkedThreadId);
  const threadChatVersion = thread?.issueDraftVersion ?? 0;
  return {
    threadChatVersion,
    stepsChatVersion,
    stale: threadChatVersion > stepsChatVersion,
  };
}

export async function snapshotWorkflowChatVersion(
  requirementId: string,
): Promise<number> {
  const req = await getBaRequirement(requirementId);
  if (!req?.linkedThreadId) return 0;
  const thread = await getBaThread(req.linkedThreadId);
  return thread?.issueDraftVersion ?? 0;
}

export async function deleteBaRequirement(
  id: string,
  userId: string,
): Promise<boolean> {
  const req = await getBaRequirement(id);
  if (!req || req.userId !== userId.toLowerCase()) return false;
  await BaRequirementModel.softDeleteMany({ id });
  await BaTaskDraftModel.softDeleteMany({ requirementId: id });
  return true;
}

/* ── BA task drafts ── */

export type BaTaskDraftStatus = "draft" | "approved" | "published" | "rejected";

export type BaTaskDraft = {
  id: string;
  userId: string;
  baProjectId: string;
  requirementId?: string | null;
  threadId?: string | null;
  messageId?: string | null;
  title: string;
  description: string;
  labels: string[];
  acceptanceCriteria: string[];
  /** Ghi chú kỹ thuật cho Dev — lưu riêng, không trộn vào mô tả nghiệp vụ. */
  devNotes?: string | null;
  /** Có đưa devNotes vào issue khi lên GitLab không (BA chọn lúc tạo task). */
  includeDevNotes?: boolean;
  milestone?: string | null;
  status: BaTaskDraftStatus;
  gitlabIid?: number | null;
  gitlabUrl?: string | null;
  createdAt: string;
  updatedAt: string;
};

export async function listBaTaskDrafts(opts: {
  userId: string;
  baProjectId?: string;
  requirementId?: string;
  status?: BaTaskDraftStatus;
}): Promise<BaTaskDraft[]> {
  const filter: Record<string, string> = { userId: opts.userId.toLowerCase() };
  if (opts.baProjectId?.trim()) filter.baProjectId = opts.baProjectId.trim();
  if (opts.requirementId?.trim()) filter.requirementId = opts.requirementId.trim();
  if (opts.status) filter.status = opts.status;
  return BaTaskDraftModel.findMany({
    filter,
    sort: { updatedAt: -1 },
  });
}

export async function getBaTaskDraft(id: string): Promise<BaTaskDraft | null> {
  return BaTaskDraftModel.findOne({ id: id.trim() });
}

export async function createBaTaskDraft(opts: {
  userId: string;
  baProjectId: string;
  title: string;
  description?: string;
  labels?: string[];
  acceptanceCriteria?: string[];
  devNotes?: string;
  includeDevNotes?: boolean;
  milestone?: string;
  requirementId?: string;
  threadId?: string;
  messageId?: string;
  status?: BaTaskDraftStatus;
}): Promise<BaTaskDraft> {
  const now = new Date().toISOString();
  const doc: BaTaskDraft = {
    id: `batd_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
    userId: opts.userId.toLowerCase(),
    baProjectId: opts.baProjectId.trim(),
    requirementId: opts.requirementId?.trim() || null,
    threadId: opts.threadId?.trim() || null,
    messageId: opts.messageId?.trim() || null,
    title: opts.title.trim(),
    description: (opts.description || "").trim(),
    labels: (opts.labels || []).map((l) => l.trim()).filter(Boolean),
    acceptanceCriteria: (opts.acceptanceCriteria || [])
      .map((s) => s.trim())
      .filter(Boolean),
    devNotes: opts.devNotes?.trim() || null,
    includeDevNotes: Boolean(opts.includeDevNotes),
    milestone: opts.milestone?.trim() || null,
    status: opts.status || "draft",
    gitlabIid: null,
    gitlabUrl: null,
    createdAt: now,
    updatedAt: now,
  };
  await BaTaskDraftModel.insert(doc);
  return doc;
}

export async function updateBaTaskDraft(
  id: string,
  patch: Partial<
    Pick<
      BaTaskDraft,
      | "title"
      | "description"
      | "labels"
      | "acceptanceCriteria"
      | "devNotes"
      | "includeDevNotes"
      | "milestone"
      | "status"
      | "gitlabIid"
      | "gitlabUrl"
    >
  >,
): Promise<BaTaskDraft | null> {
  const existing = await getBaTaskDraft(id);
  if (!existing) return null;
  const now = new Date().toISOString();
  if (patch.title !== undefined) existing.title = patch.title.trim();
  if (patch.description !== undefined) {
    existing.description = patch.description.trim();
  }
  if (patch.labels !== undefined) {
    existing.labels = patch.labels.map((l) => l.trim()).filter(Boolean);
  }
  if (patch.acceptanceCriteria !== undefined) {
    existing.acceptanceCriteria = patch.acceptanceCriteria
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (patch.devNotes !== undefined) {
    existing.devNotes = patch.devNotes?.trim() || null;
  }
  if (patch.includeDevNotes !== undefined) {
    existing.includeDevNotes = Boolean(patch.includeDevNotes);
  }
  if (patch.milestone !== undefined) {
    existing.milestone = patch.milestone?.trim() || null;
  }
  if (patch.status !== undefined) existing.status = patch.status;
  if (patch.gitlabIid !== undefined) existing.gitlabIid = patch.gitlabIid;
  if (patch.gitlabUrl !== undefined) existing.gitlabUrl = patch.gitlabUrl;
  existing.updatedAt = now;
  await BaTaskDraftModel.updateOne({ id }, { $set: existing });
  return existing;
}

export async function deleteBaTaskDraft(
  id: string,
  userId: string,
): Promise<boolean> {
  const draft = await getBaTaskDraft(id);
  if (!draft || draft.userId !== userId.toLowerCase()) return false;
  const n = await BaTaskDraftModel.softDeleteMany({ id });
  const res = { deletedCount: n };
  return res.deletedCount > 0;
}
