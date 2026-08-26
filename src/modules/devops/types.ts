/** FIFO build-script jobs — independent of Cursor/GitLab WorkBench jobs. */

export const BUILD_STATUSES = [
  "queued",
  "running",
  "success",
  "failed",
  "cancelled",
  "timeout",
] as const;

export type BuildStatus = (typeof BUILD_STATUSES)[number];

export const BUILD_LOG_STREAMS = ["stdout", "stderr", "system"] as const;
export type BuildLogStream = (typeof BUILD_LOG_STREAMS)[number];

export type WhitelistedScript = {
  id: string;
  label: string;
  /** Exact command spawned with `shell: true` — never interpolated with client input. */
  command: string;
  workingDir: string;
  timeoutSec?: number;
  description?: string;
  /** Inactive scripts stay configured but cannot be triggered. */
  active?: boolean;
};

export type BuildJob = {
  id: string;
  scriptId: string;
  scriptLabel: string;
  /** Snapshot for audit / UI — execution always re-resolves from the whitelist. */
  command: string;
  workingDir: string;
  status: BuildStatus;
  triggeredBy: string;
  note?: string;
  queuedAt: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  /** null when the process never spawned or was killed before close. */
  exitCode?: number | null;
  errorMessage?: string;
  logFile: string;
  cancelRequested?: boolean;
  createdAt: string;
  updatedAt: string;
};

export type BuildJobPublic = BuildJob;

export type BuildQueueSnapshot = {
  concurrency: 1;
  running: boolean;
  currentBuildId: string | null;
  queued: number;
  queuedIds: string[];
  shuttingDown: boolean;
};

export type BuildLogLine = {
  at: string;
  stream: BuildLogStream;
  text: string;
};

export type BuildEvent =
  | { type: "queue"; snapshot: BuildQueueSnapshot }
  | { type: "job"; job: BuildJobPublic }
  | {
      type: "log";
      buildId: string;
      at: string;
      stream: BuildLogStream;
      text: string;
    }
  | { type: "done"; buildId: string; job: BuildJobPublic };

export function isTerminalBuildStatus(status: BuildStatus): boolean {
  return (
    status === "success" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "timeout"
  );
}

export function newBuildId(): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `bld_${Date.now().toString(36)}_${rand}`;
}
