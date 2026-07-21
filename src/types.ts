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
  | "queued"
  | "running"
  | "awaiting_clarification"
  /** @deprecated legacy — migrated to succeeded on boot (push/MR gate removed) */
  | "awaiting_diff_approval"
  /** Code done (local commit) — chờ user assign / labels thủ công */
  | "awaiting_handoff"
  | "succeeded"
  | "failed";

export type JobRecord = {
  id: string;
  status: JobStatus;
  issue: IssueJob;
  agentId?: string;
  runId?: string;
  branch?: string;
  mrUrl?: string;
  clarifyRound: number;
  lastQuestion?: string;
  lastTeamsMessageId?: string;
  error?: string;
  summary?: string;
  completion?: CompletionActions;
  /** When agent finished / entered awaiting_handoff */
  completedAt?: string;
  /** When user finished handoff → succeeded */
  handedOffAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type ClarificationResult =
  | { kind: "done"; text: string }
  | { kind: "need_clarification"; question: string; text: string }
  | { kind: "error"; message: string; text?: string };
