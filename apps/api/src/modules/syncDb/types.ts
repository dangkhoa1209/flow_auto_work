/** System-wide MongoDB dump→restore jobs (concurrency hard-locked to 1). */

export const SYNC_DB_STATUSES = [
  "queued",
  "running",
  "success",
  "failed",
  "cancelled",
  "timeout",
] as const;

export type SyncDbStatus = (typeof SYNC_DB_STATUSES)[number];

export const SYNC_DB_LOG_STREAMS = ["stdout", "stderr", "system"] as const;
export type SyncDbLogStream = (typeof SYNC_DB_LOG_STREAMS)[number];

export type SyncDbPhase =
  | "queued"
  | "connecting"
  | "listing"
  | "dump"
  | "restore"
  | "done"
  | "failed";

export type SyncDbProgress = {
  phase: SyncDbPhase;
  /** Display denominator: collections × active phases (2 while dump|restore pipe). */
  total: number;
  /** dumpDone + restoreDone — climbs smoothly through the pipe. */
  done: number;
  /** Raw collection count from listCollections (0 if unknown). */
  collections?: number;
  dumpDone?: number;
  restoreDone?: number;
  current: string[];
  dbName: string;
};

export type SyncDbJob = {
  id: string;
  projectId: string;
  projectName: string;
  dbName: string;
  status: SyncDbStatus;
  triggeredBy: string;
  queuedAt: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  exitCode?: number | null;
  errorMessage?: string;
  logFile: string;
  cancelRequested?: boolean;
  progress: SyncDbProgress;
  /** Target host:port snapshot (never source/live). */
  targetHost: string;
  targetPort: number;
  createdAt: string;
  updatedAt: string;
};

export type SyncDbJobPublic = SyncDbJob;

export type SyncDbQueueSnapshot = {
  concurrency: 1;
  running: boolean;
  currentJobId: string | null;
  currentDbName: string | null;
  currentProgress: SyncDbProgress | null;
  queued: number;
  queuedIds: string[];
  shuttingDown: boolean;
};

export type SyncDbLogLine = {
  at: string;
  stream: SyncDbLogStream;
  text: string;
};

export type SyncDbEvent =
  | { type: "queue"; snapshot: SyncDbQueueSnapshot }
  | { type: "job"; job: SyncDbJobPublic }
  | {
      type: "log";
      jobId: string;
      at: string;
      stream: SyncDbLogStream;
      text: string;
    }
  | { type: "progress"; jobId: string; progress: SyncDbProgress }
  | { type: "done"; jobId: string; job: SyncDbJobPublic };

/** Encrypted-at-rest system config for SSH + source Mongo (live). */
export type SyncDbSystemConfig = {
  enabled: boolean;
  sshHost: string;
  sshPort: number;
  sshUsername: string;
  /** AES-GCM via encryptSecret — never return to clients. */
  sshPasswordEnc?: string;
  /** Optional private key (enc). Password or key required. */
  sshPrivateKeyEnc?: string;
  /** Local tunnel listen port (default 27019). */
  tunnelLocalPort: number;
  /** Mongo host as seen from SSH host (usually localhost). */
  remoteMongoHost: string;
  remoteMongoPort: number;
  sourceUsername: string;
  sourcePasswordEnc?: string;
  sourceAuthSource: string;
  /** Drop collections on target before restore (default true). */
  dropTarget: boolean;
  timeoutSec: number;
  updatedAt: string;
  updatedBy?: string;
};

export type SyncDbSystemConfigPublic = {
  configured: boolean;
  enabled: boolean;
  sshHost: string | null;
  sshPort: number;
  sshUsername: string | null;
  hasSshPassword: boolean;
  hasSshPrivateKey: boolean;
  tunnelLocalPort: number;
  remoteMongoHost: string;
  remoteMongoPort: number;
  sourceUsername: string | null;
  hasSourcePassword: boolean;
  sourceAuthSource: string;
  dropTarget: boolean;
  timeoutSec: number;
  updatedAt: string | null;
  updatedBy: string | null;
};

export type SyncDbSystemConfigPatch = {
  enabled?: boolean;
  sshHost?: string;
  sshPort?: number;
  sshUsername?: string;
  /** New password; empty keeps existing. */
  sshPassword?: string;
  sshPrivateKey?: string;
  clearSshPassword?: boolean;
  clearSshPrivateKey?: boolean;
  tunnelLocalPort?: number;
  remoteMongoHost?: string;
  remoteMongoPort?: number;
  sourceUsername?: string;
  sourcePassword?: string;
  clearSourcePassword?: boolean;
  sourceAuthSource?: string;
  dropTarget?: boolean;
  timeoutSec?: number;
};

/** In-memory only — never persist / never send to client. */
export type SyncDbSystemConfigResolved = {
  enabled: boolean;
  sshHost: string;
  sshPort: number;
  sshUsername: string;
  sshPassword: string;
  sshPrivateKey: string;
  tunnelLocalPort: number;
  remoteMongoHost: string;
  remoteMongoPort: number;
  sourceUsername: string;
  sourcePassword: string;
  sourceAuthSource: string;
  dropTarget: boolean;
  timeoutSec: number;
};

export type SyncDbCapability = {
  /** Button may show (feature + system + project mongo). */
  available: boolean;
  reason?: string;
  systemConfigured: boolean;
  featureVisible: boolean;
  projectReady: boolean;
  dbName: string | null;
};

export function isTerminalSyncDbStatus(status: SyncDbStatus): boolean {
  return (
    status === "success" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "timeout"
  );
}

export function newSyncDbId(): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `sdb_${Date.now().toString(36)}_${rand}`;
}

export function emptyProgress(dbName = ""): SyncDbProgress {
  return {
    phase: "queued",
    total: 0,
    done: 0,
    collections: 0,
    dumpDone: 0,
    restoreDone: 0,
    current: [],
    dbName,
  };
}
