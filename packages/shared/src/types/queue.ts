/**
 * BullMQ job payloads — IDs + metadata only.
 * NEVER include cursorApiKey, PAT, tokens, or RuntimeContext secrets.
 */

export type CodeAgentJobKind =
  | "run"
  | "follow_up"
  | "ask"
  | "testcases"
  | "sync_base"
  | "merge";

export interface CodeAgentJobData {
  jobId: string;
  /** Workspace project id */
  projectId: string;
  /** GitLab username (owner) — worker resolves secrets via withWorkspaceContext */
  ownerUsername: string;
  kind: CodeAgentJobKind;
  taskIid?: number;
  baseBranch?: string;
  workBranch?: string;
  forceCodePhase?: boolean;
  forceAgentPhase?: boolean;
  followUpMessage?: string;
  askOnlyMessage?: string;
  mergeTargetBranch?: string;
  /** JobStatus string to restore after follow-up/ask/merge ops */
  followUpRestoreStatus?: string;
  source?: string;
}

export type DevopsBuildJobData = {
  buildJobId: string;
  scriptId: string;
  triggeredBy: string;
};
