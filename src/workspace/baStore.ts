import type { Collection } from "mongodb";
import { connectMongo } from "../db/mongo.js";
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

export type SystemSettings = {
  id: "default";
  cursorApiKeyEnc?: string;
  cursorModel?: string;
  updatedAt: string;
};

export type SystemSettingsPublic = {
  hasCursorApiKey: boolean;
  cursorModel: string;
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

async function baProjectsCol(): Promise<Collection<BaProject>> {
  const db = await connectMongo();
  return db.collection<BaProject>("ba_projects");
}

async function systemSettingsCol(): Promise<Collection<SystemSettings>> {
  const db = await connectMongo();
  return db.collection<SystemSettings>("system_settings");
}

export async function ensureBaIndexes(): Promise<void> {
  const db = await connectMongo();
  await db.collection("ba_projects").createIndex({ slug: 1 }, { unique: true });
  await db
    .collection("ba_threads")
    .createIndex({ userId: 1, baProjectId: 1, updatedAt: -1 });
  await db.collection("ba_messages").createIndex({ threadId: 1, createdAt: 1 });
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
  return (await baProjectsCol()).find({}).sort({ displayName: 1 }).toArray();
}

export async function getBaProject(id: string): Promise<BaProject | null> {
  return (await baProjectsCol()).findOne({ id: id.trim() });
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
  await (await baProjectsCol()).insertOne(doc);
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
  await (await baProjectsCol()).updateOne({ id }, { $set: existing });
  return existing;
}

export async function deleteBaProject(id: string): Promise<boolean> {
  const res = await (await baProjectsCol()).deleteOne({ id: id.trim() });
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
  const col = await systemSettingsCol();
  const existing = await col.findOne({ id: "default" });
  if (existing) return existing;
  const doc: SystemSettings = {
    id: "default",
    cursorModel: "auto",
    updatedAt: new Date().toISOString(),
  };
  await col.updateOne({ id: "default" }, { $set: doc }, { upsert: true });
  return doc;
}

export function toPublicSystemSettings(s: SystemSettings): SystemSettingsPublic {
  return {
    hasCursorApiKey: Boolean(s.cursorApiKeyEnc),
    cursorModel: s.cursorModel?.trim() || "auto",
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

  await (await systemSettingsCol()).updateOne({ id: "default" }, update, {
    upsert: true,
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

/* ── BA threads / messages ── */

export type BaThread = {
  id: string;
  userId: string;
  baProjectId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
};

export type BaMessageRole = "user" | "assistant" | "system";

export type BaMessage = {
  id: string;
  threadId: string;
  role: BaMessageRole;
  content: string;
  createdAt: string;
};

async function threadsCol(): Promise<Collection<BaThread>> {
  const db = await connectMongo();
  return db.collection<BaThread>("ba_threads");
}

async function messagesCol(): Promise<Collection<BaMessage>> {
  const db = await connectMongo();
  return db.collection<BaMessage>("ba_messages");
}

export async function listBaThreads(
  userId: string,
  baProjectId?: string,
): Promise<BaThread[]> {
  const filter: Record<string, string> = { userId: userId.toLowerCase() };
  if (baProjectId?.trim()) filter.baProjectId = baProjectId.trim();
  return (await threadsCol())
    .find(filter)
    .sort({ updatedAt: -1 })
    .toArray();
}

export async function getBaThread(id: string): Promise<BaThread | null> {
  return (await threadsCol()).findOne({ id: id.trim() });
}

export async function createBaThread(opts: {
  userId: string;
  baProjectId: string;
  title?: string;
}): Promise<BaThread> {
  const now = new Date().toISOString();
  const doc: BaThread = {
    id: `bat_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
    userId: opts.userId.toLowerCase(),
    baProjectId: opts.baProjectId.trim(),
    title: (opts.title || "New chat").trim() || "New chat",
    createdAt: now,
    updatedAt: now,
  };
  await (await threadsCol()).insertOne(doc);
  return doc;
}

export async function updateBaThreadTitle(
  id: string,
  title: string,
): Promise<BaThread | null> {
  const now = new Date().toISOString();
  await (await threadsCol()).updateOne(
    { id: id.trim() },
    { $set: { title: title.trim() || "New chat", updatedAt: now } },
  );
  return getBaThread(id);
}

export async function touchBaThread(id: string): Promise<void> {
  await (await threadsCol()).updateOne(
    { id: id.trim() },
    { $set: { updatedAt: new Date().toISOString() } },
  );
}

export async function deleteBaThread(id: string, userId: string): Promise<boolean> {
  const thread = await getBaThread(id);
  if (!thread || thread.userId !== userId.toLowerCase()) return false;
  await (await messagesCol()).deleteMany({ threadId: id });
  const res = await (await threadsCol()).deleteOne({ id });
  return res.deletedCount > 0;
}

export async function listBaMessages(threadId: string): Promise<BaMessage[]> {
  return (await messagesCol())
    .find({ threadId: threadId.trim() })
    .sort({ createdAt: 1 })
    .toArray();
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
  await (await messagesCol()).insertOne(doc);
  await touchBaThread(opts.threadId);
  return doc;
}

export async function updateBaMessageContent(
  id: string,
  content: string,
): Promise<void> {
  await (await messagesCol()).updateOne(
    { id },
    { $set: { content } },
  );
}
