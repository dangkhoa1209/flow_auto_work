export type CompletionActions = {
  /** GitLab usernames to assign when done (UI: single assignee) */
  assignees?: string[];
  /** Labels to add when done */
  labels?: string[];
  /** Labels to remove when done */
  removeLabels?: string[];
  /** Labels to add when job starts (before agent work) */
  onStartLabels?: string[];
  /** GitLab label while job runs (UI Settings; default On-processing) */
  processingLabel?: string;
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
  /** GitLab milestone (null/undefined = not assigned) */
  milestone?: IssueMilestone | null;
};

/** Stable id: one GitLab issue → one job document forever */
export function jobIdForIssue(projectId: number, issueIid: number): string {
  return `issue-${projectId}-${issueIid}`;
}

/** Ad-hoc / hotfix session id (not tied to a GitLab issue yet) */
export function newAdhocJobId(): string {
  return `adhoc-${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

/** QA triage session id (browser ReAct → review → GitLab issue) */
export function newQaJobId(): string {
  return `qa-${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

export function isQaJob(
  job: { kind?: string } | null | undefined,
): boolean {
  return job?.kind === "qa";
}

/**
 * Unique negative placeholder iid so Mongo unique (projectId, issueIid) works
 * for multiple adhoc jobs on the same project.
 */
export function syntheticAdhocIssueIid(jobId: string): number {
  let h = 0;
  for (let i = 0; i < jobId.length; i++) {
    h = (Math.imul(31, h) + jobId.charCodeAt(i)) | 0;
  }
  const n = Math.abs(h) % 1_000_000_000;
  return -(n || 1);
}

export function isAdhocJob(
  job: Pick<JobRecord, "kind" | "issue"> | null | undefined,
): boolean {
  if (!job) return false;
  if (job.kind === "adhoc") return true;
  return (job.issue?.issueIid ?? 0) <= 0 || job.issue?.action === "adhoc";
}

export function slugifyBranchPart(title: string, max = 40): string {
  const s = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
  return s || "session";
}

export type JobStatus =
  /** Job shell — issue linked, Dev Notes in progress, not yet (re)run */
  | "draft"
  | "queued"
  | "running"
  | "awaiting_clarification"
  /** Docs phase done — awaiting PM analysis approval in UI */
  | "awaiting_docs_approval"
  /** @deprecated legacy — migrated to succeeded on boot (push/MR gate removed) */
  | "awaiting_diff_approval"
  /** Code done (GitLab API commit) — awaiting manual assign / labels */
  | "awaiting_handoff"
  /** QA agent finished capture — awaiting human review before GitLab issue */
  | "awaiting_qa_review"
  /** QA agent stuck (timeout / selector) — needs human note then continue */
  | "needs_human_intervention"
  | "succeeded"
  | "failed";

export function isJobBusy(status: JobStatus): boolean {
  // awaiting_clarification is idle — user replies via chat (not a blocked waiter)
  return status === "queued" || status === "running";
}

/** Captured failed API call during QA browser run */
export type QaNetworkFailure = {
  url: string;
  method: string;
  status: number;
  responseBody?: string;
  initiator?: string;
};

/** Captured console / runtime error during QA browser run */
export type QaConsoleError = {
  message: string;
  stack?: string;
};

/** QA-specific payload on JobRecord (kind === "qa") */
export type QaRunState = {
  targetUrl: string;
  presetId: string;
  presetRole?: string;
  testcase: string;
  actionLog?: string[];
  consoleErrors?: QaConsoleError[];
  networkFailures?: QaNetworkFailure[];
  /** Relative paths under qa-agents/artifacts/{jobId}/ */
  screenshotPaths?: string[];
  draftMarkdown?: string;
  draftTitle?: string;
  createdIssueIid?: number;
  createdIssueUrl?: string;
  adjustNotes?: string[];
};

export type JobRecord = {
  id: string;
  status: JobStatus;
  /** issue = linked GitLab task; adhoc = free session until create-issue; qa = browser triage */
  kind?: "issue" | "adhoc" | "qa";
  issue: IssueJob;
  /** Present when kind === "qa" */
  qa?: QaRunState;
  /**
   * Flow login username (workspace user) who owns/runs this job.
   * Used with withWorkspaceContext — not necessarily GitLab assignee.
   */
  ownerUsername?: string;
  /** Flow workspace project id (e.g. khoadev__ykk) */
  workspaceProjectId?: string;
  /**
   * Stable Flow task id for this job (= job.id once assigned).
   * Kept explicit so UI/API can rely on it without guessing.
   */
  flowTaskId?: string;
  /** Project / base branch used when auto-creating feat branches */
  baseBranch?: string;
  /** Fixed work branch; empty → auto feat/<iid>/slug */
  workBranch?: string;
  /** Cursor SDK agent id — one job ↔ one agent window (resume across runs) */
  agentId?: string;
  runId?: string;
  branch?: string;
  mrUrl?: string;
  /** Latest commit SHA after a successful run (GitLab API) */
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
  /** Sticky context-quality mark for coding Runs / follow-ups.
   * level === "good" → skip re-assessment on later agent calls.
   */
  contextQuality?: {
    level: "good" | "searchable" | "bad";
    assessedAt: string;
    reason?: string;
    anchors?: string[];
    fileHints?: string[];
  };
  /**
   * Chat "Send" command waiting in the job queue (not a full Run).
   * Cleared when the follow-up starts executing.
   */
  pendingFollowUpMessage?: string;
  /** send = chat Send (may edit code); ask = Ask only (Q&A). Needed to restore the right kind after restart. */
  pendingFollowUpKind?: "send" | "ask";
  /** Status to restore if a queued follow-up is cancelled / fails soft. */
  followUpRestoreStatus?: JobStatus;
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

/** Trimmed Dev Notes from job (UI / Mongo). */
export function resolveDevNotes(job: Pick<JobRecord, "devNotes">): string {
  return (job.devNotes ?? "").trim();
}

export type ClarificationResult =
  | { kind: "done"; text: string }
  | { kind: "need_clarification"; question: string; text: string }
  | { kind: "error"; message: string; text?: string };
