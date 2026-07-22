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

export type IssueMilestone = {
  id: number;
  title: string;
  state?: string;
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
  /** GitLab milestone (null/undefined = chưa gán) */
  milestone?: IssueMilestone | null;
};

export type JobStatus =
  /** Job shell — đã gắn issue, có thể đang viết Dev Notes, chưa (re)run */
  | "draft"
  | "queued"
  | "running"
  | "awaiting_clarification"
  /** Docs phase xong — chờ PM duyệt analysis trong UI */
  | "awaiting_docs_approval"
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
  /** GitLab username who owns/runs this job */
  ownerUsername?: string;
  /** Workspace project id (multi-project) */
  workspaceProjectId?: string;
  /** Project / base branch used when auto-creating feat branches */
  baseBranch?: string;
  /** Fixed work branch; empty → auto feat/<iid>/slug */
  workBranch?: string;
  /** Cursor SDK agent id — one job ↔ one agent window (resume across runs) */
  agentId?: string;
  runId?: string;
  branch?: string;
  mrUrl?: string;
  /** Latest local commit SHA after a successful run (post-scrub) */
  commitSha?: string;
  /** History of commit SHAs across re-runs (newest last) */
  commitShas?: string[];
  /** Last reported Cursor token usage (for context-window % UI) */
  tokenUsage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    /** Last-turn inputTokens (best proxy for context fill) */
    lastInputTokens?: number;
    contextWindow: number;
    /** 0–100 estimate: lastInputTokens / contextWindow */
    contextPct: number;
    updatedAt: string;
  };
  clarifyRound: number;
  /** How many agent runs completed or started on this job */
  runCount: number;
  lastQuestion?: string;
  lastTeamsMessageId?: string;
  error?: string;
  summary?: string;
  /** Docs-phase summary (Vietnamese) while awaiting approval */
  docsSummary?: string;
  completion?: CompletionActions;
  /** Dev notes — highest priority in agent prompt (Mongo only) */
  devNotes?: string;
  /** @deprecated use devNotes */
  techLeadNotes?: string;
  /** Hard gate: read/update AiHR feature docs before any app code */
  requireDocsFirst?: boolean;
  /** Feature doc paths from docs phase (.md / .mdc under docs/), for PM review */
  docsPaths?: string[];
  /** @deprecated prefer docsPaths */
  docsPath?: string;
  /** Set when PM approves docs → next run is code phase */
  docsApprovedAt?: string;
  /** When agent finished / entered awaiting_handoff */
  completedAt?: string;
  /** When user finished handoff → succeeded */
  handedOffAt?: string;
  /** Local merge of work branch into project/base branch */
  mergedAt?: string;
  mergeTarget?: string;
  mergeSource?: string;
  mergeSha?: string;
  /** True if Cursor agent resolved conflicts during merge */
  mergeAiResolved?: boolean;
  /** When target branch was pushed to origin after merge */
  mergePushedAt?: string;
  mergePushError?: string;
  mergeError?: string;
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
