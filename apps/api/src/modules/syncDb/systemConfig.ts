import { SystemSettingsModel } from "../../models/ba.js";
import { decryptSecret, encryptSecret } from "../../plugins/crypto/secrets.js";
import { AppError } from "../../utils/AppError.js";
import { getSystemSettings } from "../../workspace/baStore.js";
import type {
  SyncDbSystemConfig,
  SyncDbSystemConfigPatch,
  SyncDbSystemConfigPublic,
  SyncDbSystemConfigResolved,
} from "./types.js";

const DEFAULTS = {
  tunnelLocalPort: 27019,
  remoteMongoHost: "localhost",
  remoteMongoPort: 27017,
  sourceAuthSource: "admin",
  dropTarget: true,
  timeoutSec: 3600,
  sshPort: 22,
} as const;

function trim(s: unknown): string {
  return String(s ?? "").trim();
}

export function toPublicSyncDbConfig(
  raw: SyncDbSystemConfig | null | undefined,
): SyncDbSystemConfigPublic {
  if (!raw) {
    return {
      configured: false,
      enabled: false,
      sshHost: null,
      sshPort: DEFAULTS.sshPort,
      sshUsername: null,
      hasSshPassword: false,
      hasSshPrivateKey: false,
      tunnelLocalPort: DEFAULTS.tunnelLocalPort,
      remoteMongoHost: DEFAULTS.remoteMongoHost,
      remoteMongoPort: DEFAULTS.remoteMongoPort,
      sourceUsername: null,
      hasSourcePassword: false,
      sourceAuthSource: DEFAULTS.sourceAuthSource,
      dropTarget: DEFAULTS.dropTarget,
      timeoutSec: DEFAULTS.timeoutSec,
      updatedAt: null,
      updatedBy: null,
    };
  }
  const hasSshPassword = Boolean(raw.sshPasswordEnc);
  const hasSshPrivateKey = Boolean(raw.sshPrivateKeyEnc);
  const hasSourcePassword = Boolean(raw.sourcePasswordEnc);
  const configured = Boolean(
    raw.sshHost &&
      raw.sshUsername &&
      (hasSshPassword || hasSshPrivateKey) &&
      raw.sourceUsername &&
      hasSourcePassword,
  );
  return {
    configured,
    enabled: Boolean(raw.enabled),
    sshHost: raw.sshHost || null,
    sshPort: raw.sshPort || DEFAULTS.sshPort,
    sshUsername: raw.sshUsername || null,
    hasSshPassword,
    hasSshPrivateKey,
    tunnelLocalPort: raw.tunnelLocalPort || DEFAULTS.tunnelLocalPort,
    remoteMongoHost: raw.remoteMongoHost || DEFAULTS.remoteMongoHost,
    remoteMongoPort: raw.remoteMongoPort || DEFAULTS.remoteMongoPort,
    sourceUsername: raw.sourceUsername || null,
    hasSourcePassword,
    sourceAuthSource: raw.sourceAuthSource || DEFAULTS.sourceAuthSource,
    dropTarget: raw.dropTarget !== false,
    timeoutSec: raw.timeoutSec || DEFAULTS.timeoutSec,
    updatedAt: raw.updatedAt || null,
    updatedBy: raw.updatedBy || null,
  };
}

export function isSyncDbSystemReady(
  raw: SyncDbSystemConfig | null | undefined,
): boolean {
  const pub = toPublicSyncDbConfig(raw);
  return pub.configured && pub.enabled;
}

export async function getSyncDbSystemConfig(): Promise<SyncDbSystemConfig | null> {
  const s = await getSystemSettings();
  const raw = (s as { syncDb?: SyncDbSystemConfig }).syncDb;
  return raw ?? null;
}

export async function getSyncDbSystemConfigPublic(): Promise<SyncDbSystemConfigPublic> {
  return toPublicSyncDbConfig(await getSyncDbSystemConfig());
}

/** Decrypt for runner only — never log or return to HTTP. */
export async function resolveSyncDbSystemConfig(): Promise<SyncDbSystemConfigResolved> {
  const raw = await getSyncDbSystemConfig();
  const pub = toPublicSyncDbConfig(raw);
  if (!pub.configured || !raw) {
    throw new AppError(
      "Sync Database is not configured — admin must set SSH + source Mongo credentials",
      409,
      "sync_db_not_configured",
    );
  }
  if (!raw.enabled) {
    throw new AppError(
      "Sync Database is disabled by admin",
      409,
      "sync_db_disabled",
    );
  }
  return {
    enabled: true,
    sshHost: raw.sshHost,
    sshPort: raw.sshPort || DEFAULTS.sshPort,
    sshUsername: raw.sshUsername,
    sshPassword: raw.sshPasswordEnc ? decryptSecret(raw.sshPasswordEnc) : "",
    sshPrivateKey: raw.sshPrivateKeyEnc
      ? decryptSecret(raw.sshPrivateKeyEnc)
      : "",
    tunnelLocalPort: raw.tunnelLocalPort || DEFAULTS.tunnelLocalPort,
    remoteMongoHost: raw.remoteMongoHost || DEFAULTS.remoteMongoHost,
    remoteMongoPort: raw.remoteMongoPort || DEFAULTS.remoteMongoPort,
    sourceUsername: raw.sourceUsername,
    sourcePassword: raw.sourcePasswordEnc
      ? decryptSecret(raw.sourcePasswordEnc)
      : "",
    sourceAuthSource: raw.sourceAuthSource || DEFAULTS.sourceAuthSource,
    dropTarget: raw.dropTarget !== false,
    timeoutSec: Math.max(60, raw.timeoutSec || DEFAULTS.timeoutSec),
  };
}

export async function updateSyncDbSystemConfig(
  patch: SyncDbSystemConfigPatch,
  updatedBy: string,
): Promise<SyncDbSystemConfigPublic> {
  const existing = (await getSyncDbSystemConfig()) || ({} as SyncDbSystemConfig);
  const now = new Date().toISOString();

  const sshHost = patch.sshHost !== undefined ? trim(patch.sshHost) : existing.sshHost || "";
  const sshUsername =
    patch.sshUsername !== undefined
      ? trim(patch.sshUsername)
      : existing.sshUsername || "";
  const sourceUsername =
    patch.sourceUsername !== undefined
      ? trim(patch.sourceUsername)
      : existing.sourceUsername || "";

  let sshPasswordEnc = existing.sshPasswordEnc;
  if (patch.clearSshPassword) sshPasswordEnc = undefined;
  else if (patch.sshPassword !== undefined && trim(patch.sshPassword)) {
    sshPasswordEnc = encryptSecret(trim(patch.sshPassword));
  }

  let sshPrivateKeyEnc = existing.sshPrivateKeyEnc;
  if (patch.clearSshPrivateKey) sshPrivateKeyEnc = undefined;
  else if (patch.sshPrivateKey !== undefined && trim(patch.sshPrivateKey)) {
    sshPrivateKeyEnc = encryptSecret(patch.sshPrivateKey);
  }

  let sourcePasswordEnc = existing.sourcePasswordEnc;
  if (patch.clearSourcePassword) sourcePasswordEnc = undefined;
  else if (patch.sourcePassword !== undefined && trim(patch.sourcePassword)) {
    sourcePasswordEnc = encryptSecret(trim(patch.sourcePassword));
  }

  const sshPort =
    patch.sshPort !== undefined
      ? Number(patch.sshPort)
      : existing.sshPort || DEFAULTS.sshPort;
  const tunnelLocalPort =
    patch.tunnelLocalPort !== undefined
      ? Number(patch.tunnelLocalPort)
      : existing.tunnelLocalPort || DEFAULTS.tunnelLocalPort;
  const remoteMongoPort =
    patch.remoteMongoPort !== undefined
      ? Number(patch.remoteMongoPort)
      : existing.remoteMongoPort || DEFAULTS.remoteMongoPort;
  const timeoutSec =
    patch.timeoutSec !== undefined
      ? Number(patch.timeoutSec)
      : existing.timeoutSec || DEFAULTS.timeoutSec;

  if (!Number.isFinite(sshPort) || sshPort < 1 || sshPort > 65535) {
    throw new AppError("Invalid SSH port", 400);
  }
  if (
    !Number.isFinite(tunnelLocalPort) ||
    tunnelLocalPort < 1 ||
    tunnelLocalPort > 65535
  ) {
    throw new AppError("Invalid tunnel local port", 400);
  }
  if (
    !Number.isFinite(remoteMongoPort) ||
    remoteMongoPort < 1 ||
    remoteMongoPort > 65535
  ) {
    throw new AppError("Invalid remote Mongo port", 400);
  }
  if (!Number.isFinite(timeoutSec) || timeoutSec < 60) {
    throw new AppError("timeoutSec must be >= 60", 400);
  }

  const doc: SyncDbSystemConfig = {
    enabled:
      patch.enabled !== undefined ? Boolean(patch.enabled) : Boolean(existing.enabled),
    sshHost,
    sshPort,
    sshUsername,
    tunnelLocalPort,
    remoteMongoHost:
      patch.remoteMongoHost !== undefined
        ? trim(patch.remoteMongoHost) || DEFAULTS.remoteMongoHost
        : existing.remoteMongoHost || DEFAULTS.remoteMongoHost,
    remoteMongoPort,
    sourceUsername,
    sourceAuthSource:
      patch.sourceAuthSource !== undefined
        ? trim(patch.sourceAuthSource) || DEFAULTS.sourceAuthSource
        : existing.sourceAuthSource || DEFAULTS.sourceAuthSource,
    dropTarget:
      patch.dropTarget !== undefined
        ? Boolean(patch.dropTarget)
        : existing.dropTarget !== false,
    timeoutSec,
    updatedAt: now,
    updatedBy,
  };
  if (sshPasswordEnc) doc.sshPasswordEnc = sshPasswordEnc;
  if (sshPrivateKeyEnc) doc.sshPrivateKeyEnc = sshPrivateKeyEnc;
  if (sourcePasswordEnc) doc.sourcePasswordEnc = sourcePasswordEnc;

  if (doc.enabled) {
    const pub = toPublicSyncDbConfig(doc);
    if (!pub.configured) {
      throw new AppError(
        "Cannot enable Sync DB until SSH host/user + (password or key) and source Mongo user/password are set",
        400,
        "sync_db_incomplete",
      );
    }
  }

  await SystemSettingsModel.upsertOne(
    { id: "default" },
    { syncDb: doc, updatedAt: now },
  );
  return toPublicSyncDbConfig(doc);
}
