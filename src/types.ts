export type CompletionActions = {
  /** GitLab usernames to assign when done (UI: 1 người) */
  assignees?: string[];
  /** Labels to add when done */
  labels?: string[];
  /** Labels to remove when done */
  removeLabels?: string[];
  /** Labels to add when job starts (before agent work) */
  onStartLabels?: string[];
  /** @deprecated prefer labels + removeLabels */
  labelMode?: "add" | "set";
  /** Extra comment body (in addition to default success comment) */
  comment?: string;
};

export type IssueJob = {
  projectId: number;
  projectPath: string;
  issueIid: number;
  issueId: number;
  title: string;
  description: string;
  labels: string[];
  url: string;
  action: string;
};

export type JobStatus =
  /** Job shell — đã gắn issue, có thể đang viết Dev Notes, chưa (re)run */
  | "draft"
  | "queued"
  | "running"
  | "awaiting_clarification"
  /** @deprecated legacy — migrated to succeeded on boot (push/MR gate removed) */
  | "awaiting_diff_approval"
  /** Code done (local commit) — chờ user assign / labels thủ công */
  | "awaiting_handoff"
  | "succeeded"
  | "failed";

/** Stable id: one GitLab issue → one job document forever */
export function jobIdForIssue(projectId: number, issueIid: number): string {
  return `issue-${projectId}-${issueIid}`;
}

export function isJobBusy(status: JobStatus): boolean {
  return (
    status === "queued" ||
    status === "running" ||
    status === "awaiting_clarification"
  );
}

export type JobRecord = {
  id: string;
  status: JobStatus;
  issue: IssueJob;
  agentId?: string;
  runId?: string;
  branch?: string;
  mrUrl?: string;
  /** Latest local commit SHA after a successful run (post-scrub) */
  commitSha?: string;
  /** History of commit SHAs across re-runs (newest last) */
  commitShas?: string[];
  clarifyRound: number;
  /** How many agent runs completed or started on this job */
  runCount: number;
  lastQuestion?: string;
  lastTeamsMessageId?: string;
  error?: string;
  summary?: string;
  completion?: CompletionActions;
  /** Dev notes — highest priority in agent prompt (Mongo only) */
  devNotes?: string;
  /** @deprecated use devNotes */
  techLeadNotes?: string;
  /** When agent finished / entered awaiting_handoff */
  completedAt?: string;
  /** When user finished handoff → succeeded */
  handedOffAt?: string;
  createdAt: string;
  updatedAt: string;
};

/** Prefer devNotes; fall back to legacy techLeadNotes */
export function resolveDevNotes(job: Pick<JobRecord, "devNotes" | "techLeadNotes">): string {
  return (job.devNotes ?? job.techLeadNotes ?? "").trim();
}

export type ClarificationResult =
  | { kind: "done"; text: string }
  | { kind: "need_clarification"; question: string; text: string }
  | { kind: "error"; message: string; text?: string };
