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

/** Pre-workspace id: one GitLab issue → one job (legacy docs still use this). */
export function legacyJobIdForIssue(
  projectId: number,
  issueIid: number,
): string {
  return `issue-${projectId}-${issueIid}`;
}

/**
 * Stable id: GitLab issue scoped to a Flow workspace project.
 * With `workspaceProjectId` → `issue-{glProject}-{iid}--{workspaceProjectId}`
 * so the same GitLab issue can have one job per Flow project.
 * Without workspace → legacy id (boot / migrate only).
 */
export function jobIdForIssue(
  projectId: number,
  issueIid: number,
  workspaceProjectId?: string,
): string {
  const ws = workspaceProjectId?.trim();
  if (ws) return `issue-${projectId}-${issueIid}--${ws}`;
  return legacyJobIdForIssue(projectId, issueIid);
}

/** Ad-hoc / hotfix session id (not tied to a GitLab issue yet) */
export function newAdhocJobId(): string {
  return `adhoc-${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
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

import type { JobStatus } from "@flow/shared";
export type { JobStatus } from "@flow/shared";
export { isJobBusy } from "@flow/shared";

/** Encrypted Google OAuth tokens for reading Sheets (per job). */
export type JobGoogleAuth = {
  email?: string;
  refreshTokenEnc: string;
  accessTokenEnc?: string;
  accessExpiresAt?: string;
  scopes: string[];
  /** Spreadsheet IDs seen/authorized for this job */
  sheetIds: string[];
  authorizedAt: string;
  revokedAt?: string;
};

export type JobRecord = {
  id: string;
  status: JobStatus;
  /** issue = linked GitLab task; adhoc = free session until create-issue */
  kind?: "issue" | "adhoc";
  issue: IssueJob;
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
  /** Open MR iid when Create MR was used */
  mrIid?: number;
  /**
   * When to push agent edits via GitLab Commits API.
   * Default `auto` — commit after each Run/follow-up; `manual` = user clicks Commit.
   */
  commitMode?: "manual" | "auto";
  /** Local dirty tree waiting for manual Commit */
  hasPendingChanges?: boolean;
  /** Google OAuth (encrypted) for Sheets links in this task */
  googleAuth?: JobGoogleAuth;
  /** Sheet URLs detected when paused for Google auth */
  pendingGoogleSheetUrls?: string[];
  /**
   * Spreadsheet IDs the user opted in to read before Run.
   * Empty / unset = do not fetch Sheets (default).
   */
  googleSheetsIncludeIds?: string[];
  /**
   * Figma include keys (`fileKey` or `fileKey#nodeId`) opted in before Run.
   * Empty / unset = do not fetch Figma (default).
   */
  figmaIncludeKeys?: string[];
  /** Figma URLs when paused for missing project PAT */
  pendingFigmaUrls?: string[];
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
  /** Hard gate: read/update project feature docs before any app code */
  requireDocsFirst?: boolean;
  /** Plan-first: Cursor `mode: "plan"` then PM approves before coding */
  planFirst?: boolean;
  /** Plan-phase summary (Vietnamese) while awaiting approval */
  planSummary?: string;
  /** Set when PM approves plan → next run is code phase */
  planApprovedAt?: string;
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
  /**
   * Sync-base / merge left an open git merge with conflict markers.
   * User can Chat Send to resolve; orchestrator finalizes when markers are gone.
   */
  pendingConflictResolve?: {
    kind: "sync-base" | "merge";
    /** Branch being merged in (incoming) */
    source: string;
    /** Branch checked out that receives the merge */
    target: string;
    files: string[];
    /** WIP stash kept until finalize or abort */
    wipStashMarker?: string | null;
    startedAt: string;
  };
  createdAt: string;
  updatedAt: string;
};

/** Queue / busy key: workspace + GitLab issue (not shared across Flow projects). */
export function busyIssueKey(
  workspaceProjectId: string | undefined | null,
  projectId: number,
  issueIid: number,
): string {
  const ws = (workspaceProjectId || "").trim() || "default";
  return `${ws}:${projectId}:${issueIid}`;
}

export function busyIssueKeyForJob(
  job: Pick<JobRecord, "workspaceProjectId" | "issue">,
): string {
  return busyIssueKey(
    job.workspaceProjectId,
    job.issue.projectId,
    job.issue.issueIid,
  );
}

/** Trimmed Dev Notes from job (UI / Mongo). */
export function resolveDevNotes(job: Pick<JobRecord, "devNotes">): string {
  return (job.devNotes ?? "").trim();
}

export type ClarificationResult =
  | { kind: "done"; text: string }
  | { kind: "need_clarification"; question: string; text: string }
  | { kind: "error"; message: string; text?: string };
