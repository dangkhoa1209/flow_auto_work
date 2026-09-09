import { AppError } from "../../utils/AppError.js";
import type { BaDbConnectionResolved } from "../../workspace/baStore.js";
import type { SyncDbSystemConfigResolved } from "./types.js";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

/** Mongo actions that imply write / destructive access on live. */
const WRITE_ACTIONS = new Set([
  "insert",
  "update",
  "remove",
  "findAndModify",
  "createCollection",
  "dropCollection",
  "dropDatabase",
  "createIndex",
  "dropIndex",
  "collMod",
  "renameCollection",
  "convertToCapped",
  "emptycapped",
  "reIndex",
  "compact",
  "anyAction",
]);

export function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/^\[|\]$/g, "");
}

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK.has(normalizeHost(host));
}

/**
 * Hard safety: restore ONLY to loopback Connect DB targets.
 * Never allow restore host to match SSH bastion or remote Mongo host (when remote is not loopback-on-bastion).
 * Never restore onto the local tunnel port (would hit live).
 */
export function assertSafeRestoreTarget(
  target: BaDbConnectionResolved,
  source: SyncDbSystemConfigResolved,
): void {
  const th = normalizeHost(target.host);
  const ssh = normalizeHost(source.sshHost);
  const remoteMongo = normalizeHost(source.remoteMongoHost);

  if (!th) {
    throw new AppError("Target DB host missing", 400, "sync_db_bad_target");
  }

  // Strict allowlist — no extra admin/server setup: only local restore.
  if (!isLoopbackHost(th)) {
    throw new AppError(
      "Refusing sync: restore target must be loopback (127.0.0.1 / localhost) — never a remote/live host",
      403,
      "sync_db_live_forbidden",
    );
  }

  if (th === ssh) {
    throw new AppError(
      "Refusing sync: target host matches SSH/live server — restore to live is forbidden",
      403,
      "sync_db_live_forbidden",
    );
  }

  // When remoteMongoHost is a real address (not "localhost on bastion"), block matching target.
  if (!isLoopbackHost(remoteMongo) && th === remoteMongo) {
    throw new AppError(
      "Refusing sync: target host matches remote Mongo (live) host",
      403,
      "sync_db_live_forbidden",
    );
  }

  if (isLoopbackHost(th) && target.port === source.tunnelLocalPort) {
    throw new AppError(
      "Refusing sync: target port equals tunnel port (would hit live via tunnel)",
      403,
      "sync_db_live_forbidden",
    );
  }
}

type PrivilegeDoc = {
  resource?: {
    db?: string;
    collection?: string;
    cluster?: boolean;
    anyResource?: boolean;
  };
  actions?: string[];
};

function privilegeTouchesDb(
  resource: PrivilegeDoc["resource"],
  dbName: string,
): boolean {
  if (!resource) return false;
  if (resource.anyResource) return true;
  // Cluster privileges are not application-DB writes; root/clusterAdmin caught via roles.
  if (resource.cluster) return false;
  const db = resource.db;
  // Empty db = any database
  if (db === "" || db === undefined) return true;
  return db === dbName;
}

function actionsIncludeWrite(actions: string[] | undefined): boolean {
  if (!actions?.length) return false;
  return actions.some((a) => WRITE_ACTIONS.has(a));
}

/**
 * Fail closed if source Mongo user can write the live DB (or any DB).
 * Uses connectionStatus showPrivileges — no insert probe, no server setup.
 */
export function assertSourceUserReadonly(
  connectionStatus: {
    authInfo?: {
      authenticatedUserPrivileges?: PrivilegeDoc[];
      authenticatedUserRoles?: { role?: string; db?: string }[];
    };
  },
  dbName: string,
): void {
  const privs = connectionStatus.authInfo?.authenticatedUserPrivileges ?? [];
  const roles = connectionStatus.authInfo?.authenticatedUserRoles ?? [];

  const roleNames = roles.map((r) => String(r.role || "").toLowerCase());
  const dangerousRoles = [
    "root",
    "dbowner",
    "dbadmin",
    "useradmin",
    "readwrite",
    "readwriteanydatabase",
    "hostmanager",
    "clusteradmin",
    "clustermanager",
  ];
  for (const name of roleNames) {
    if (dangerousRoles.includes(name)) {
      throw new AppError(
        `Refusing sync: source Mongo role '${name}' can write live — use a read-only (or backup) user`,
        403,
        "sync_db_source_not_readonly",
      );
    }
  }

  for (const priv of privs) {
    if (!privilegeTouchesDb(priv.resource, dbName)) continue;
    if (actionsIncludeWrite(priv.actions)) {
      throw new AppError(
        "Refusing sync: source Mongo user has write privileges on live — use a read-only user",
        403,
        "sync_db_source_not_readonly",
      );
    }
  }
}

export function isDuplicateKeyError(err: unknown): boolean {
  return Boolean(
    err &&
      typeof err === "object" &&
      (err as { code?: number }).code === 11000,
  );
}
