import { getConfig } from "./config.js";
import {
  getHeadSha,
  hasUncommittedChanges,
  prepareRepoForIssue,
} from "./plugins/git/prep.js";
import {
  getProjectDefaultBranch,
} from "./plugins/gitlab/client.js";
import {
  finalizeGitlabCommitForJob,
  markPendingChangesIfDirty,
  resolveCommitMode,
} from "./modules/job/commit.js";
import { postAgentGitlabComments } from "./plugins/gitlab/agent-comment.js";
import { ensureJob, listJobs, loadJob, saveJob } from "./job-store.js";
import { logger } from "./logger.js";
import {
  cancelActiveAgentRun,
  continueAgentWindow,
  hasActiveAgentRun,
  isStartupError,
  isTransientCursorTransportError,
  runNewAgent,
} from "./plugins/agent/run.js";
import { runVerifyCommand } from "./plugins/verify/run.js";
import { answerTaskQuestion } from "./plugins/agent/qa.js";
import { appendJobProgress, getJobTokenUsage } from "./plugins/agent/progress.js";
import { cancelDiffApproval } from "./plugins/review/diff-wait.js";
import { addChatMessage, listChatMessages } from "./db/mongo.js";
import { publishRealtime } from "./plugins/realtime/hub.js";
import {
  commitMessageForIssue,
  docsCommitMessageForIssue,
  extractChatBodyFromAgentText,
  formatChatContextForRun,
} from "./plugins/agent/prompt.js";
import {
  formatBadContextChatMessage,
  formatContextQualityForPrompt,
  resolveContextQualityForCoding,
  toContextQualityMark,
} from "./plugins/agent/context-quality.js";
import {
  docsReadySummaryText,
  formatDocsReadyChatBody,
  parseDocsReadyPaths,
} from "./plugins/docs/analysis.js";
import type { CompletionActions, IssueJob, JobRecord, JobStatus } from "./types.js";
import { busyIssueKey, busyIssueKeyForJob, isJobBusy, resolveDevNotes } from "./types.js";
import { getRuntimeContext } from "./workspace/runtime.js";
import { withWorkspaceContext } from "./workspace/context.js";

type QueueItem = {
  job: JobRecord;
  source?: string;
  /** After PM approves docs — force code phase even if requireDocsFirst */
  forceCodePhase?: boolean;
  /** Chat Send command — run IDE follow-up (may edit code) */
  followUpMessage?: string;
  /** Chat Ask only — Q&A / review, no coding Run */
  askOnlyMessage?: string;
  /** Status before this follow-up/ask was queued (restore if no code change) */
  followUpRestoreStatus?: JobStatus;
};

export class JobQueue {
  private queue: QueueItem[] = [];
  /** Lanes currently pumping — one worker per workspace project. */
  private runningLanes = new Set<string>();
  private activeIssueKeys = new Set<string>();
  private sources = new Map<string, string>();
  /** Currently executing job per lane (not merely queued). */
  private currentByLane = new Map<string, string>();
  /** Jobs force-stopped — runJob should abort ASAP. */
  private killedJobs = new Set<string>();

  /** Per user + project: A running on project X does not block B on the same project. */
  private laneKeyFor(
    job: Pick<JobRecord, "workspaceProjectId" | "ownerUsername">,
  ): string {
    const project = job.workspaceProjectId || "default";
    const owner = (job.ownerUsername || "").trim().toLowerCase() || "anon";
    return `${project}::${owner}`;
  }

  private jobScopes = new Map<
    string,
    { owner: string; projectId: string }
  >();

  rememberJobScope(
    job: Pick<JobRecord, "id" | "ownerUsername" | "workspaceProjectId">,
  ): void {
    this.jobScopes.set(job.id, {
      owner: (job.ownerUsername || "").trim().toLowerCase(),
      projectId: (job.workspaceProjectId || "").trim(),
    });
  }

  ownerOf(jobId: string): string | undefined {
    const owner = this.jobScopes.get(jobId)?.owner;
    return owner || undefined;
  }

  eventVisibleTo(
    ev: { type: string; jobId?: string; userId?: string },
    viewer: { ownerUsername?: string; workspaceProjectId?: string },
  ): boolean {
    const me = (viewer.ownerUsername || "").trim().toLowerCase();
    const project = (viewer.workspaceProjectId || "").trim();
    if (ev.type.startsWith("ba_")) {
      if (!me || !ev.userId) return true;
      return ev.userId.trim().toLowerCase() === me;
    }
    if (!ev.jobId) return true;
    const scope = this.jobScopes.get(ev.jobId);
    if (!scope) return true;
    if (me && scope.owner && scope.owner !== me) return false;
    if (project && scope.projectId && scope.projectId !== project) return false;
    return true;
  }

  private get currentJobIds(): string[] {
    return [...this.currentByLane.values()];
  }

  private isCurrent(jobId: string): boolean {
    return this.currentJobIds.includes(jobId);
  }

  private setCurrent(job: JobRecord): void {
    this.rememberJobScope(job);
    this.currentByLane.set(this.laneKeyFor(job), job.id);
  }

  private clearCurrent(jobId: string): void {
    for (const [lane, id] of this.currentByLane) {
      if (id === jobId) this.currentByLane.delete(lane);
    }
  }

  snapshot(filter?: { ownerUsername?: string; workspaceProjectId?: string }) {
    return this.snapshotFor(filter);
  }

  snapshotFor(filter?: {
    ownerUsername?: string;
    workspaceProjectId?: string;
  }) {
    const me = (filter?.ownerUsername || "").trim().toLowerCase();
    const project = (filter?.workspaceProjectId || "").trim();
    const inScope = (jobId: string, fallbackOwner?: string, fallbackProject?: string) => {
      const scope = this.jobScopes.get(jobId);
      const owner = scope?.owner || (fallbackOwner || "").toLowerCase();
      const pid = scope?.projectId || fallbackProject || "";
      if (me && owner && owner !== me) return false;
      if (project && pid && pid !== project) return false;
      return true;
    };

    const currentJobIds = this.currentJobIds.filter((id) => inScope(id));
    const queuedItems = this.queue.filter((q) =>
      inScope(q.job.id, q.job.ownerUsername, q.job.workspaceProjectId),
    );
    return {
      running: currentJobIds.length > 0,
      queued: queuedItems.length,
      currentJobId: currentJobIds[0] ?? null,
      currentJobIds,
      activeIssues: [...this.activeIssueKeys],
    };
  }

  /** Push queue status to SSE subscribers. */
  publishStatus(reason?: string) {
    const snap = this.snapshot();
    publishRealtime({
      type: "status",
      currentJobId: snap.currentJobId,
      currentJobIds: snap.currentJobIds,
      queueLength: snap.queued,
      running: snap.running,
    });
    if (reason) {
      publishRealtime({ type: "jobs", reason });
    }
  }

  /**
   * Boot recovery: re-enqueue jobs left `queued` in DB by a restart
   * (running jobs are failed by failInterruptedJobs).
   */
  async restoreQueuedJobs(): Promise<number> {
    const jobs = await listJobs();
    let restored = 0;
    for (const job of jobs) {
      if (job.status !== "queued") continue;
      const key = busyIssueKeyForJob(job);
      if (
        this.activeIssueKeys.has(key) ||
        this.queue.some((q) => q.job.id === job.id)
      ) {
        continue;
      }
      this.activeIssueKeys.add(key);
      this.rememberJobScope(job);
      const pendingMsg = job.pendingFollowUpMessage?.trim();
      if (pendingMsg && job.pendingFollowUpKind === "ask") {
        this.queue.push({
          job,
          source: "restore_ask",
          askOnlyMessage: pendingMsg,
          followUpRestoreStatus: job.followUpRestoreStatus,
        });
      } else if (pendingMsg) {
        this.queue.push({
          job,
          source: "restore_followup",
          followUpMessage: pendingMsg,
          followUpRestoreStatus: job.followUpRestoreStatus,
        });
      } else {
        this.queue.push({ job, source: "restore" });
      }
      restored += 1;
      logger.info("Restored queued job after restart", {
        jobId: job.id,
        iid: job.issue.issueIid,
        kind: pendingMsg ? job.pendingFollowUpKind || "send" : "run",
      });
    }
    if (restored > 0) {
      this.publishStatus("restore");
      void this.pump();
    }
    return restored;
  }

  /**
   * One issue → one job. Re-run reuses the same document (chat/notes/context).
   */
  async enqueue(
    issue: IssueJob,
    opts?: {
      source?: string;
      completion?: CompletionActions;
      devNotes?: string;
      requireDocsFirst?: boolean;
      forceCodePhase?: boolean;
    },
  ): Promise<{ enqueued: boolean; reason?: string; jobId?: string }> {
    const rt = getRuntimeContext();
    const key = busyIssueKey(
      rt?.projectId,
      issue.projectId,
      issue.issueIid,
    );
    if (this.activeIssueKeys.has(key)) {
      logger.warn("enqueue rejected — activeIssueKeys", { key, iid: issue.issueIid });
      return { enqueued: false, reason: "Issue already queued or running" };
    }
    if (this.queue.some((q) => busyIssueKeyForJob(q.job) === key)) {
      logger.warn("enqueue rejected — already in memory queue", { key, iid: issue.issueIid });
      return { enqueued: false, reason: "Issue already queued or running" };
    }

    const notes = opts?.devNotes?.trim() || undefined;

    const job = await ensureJob(issue, {
      source: opts?.source,
      completion: opts?.completion,
      devNotes: notes,
      requireDocsFirst: opts?.requireDocsFirst,
    });

    if (
      rt?.projectId &&
      job.workspaceProjectId?.trim() &&
      job.workspaceProjectId.trim() !== rt.projectId
    ) {
      return {
        enqueued: false,
        reason: "Job belongs to another project — switch project to run it",
      };
    }

    if (notes !== undefined) {
      job.devNotes = notes || undefined;
    }
    if (opts?.completion) job.completion = opts.completion;
    if (opts?.requireDocsFirst !== undefined) {
      job.requireDocsFirst = opts.requireDocsFirst;
    }

    if (isJobBusy(job.status) && !this.isCurrent(job.id)) {
      const fresh = await loadJob(job.id);
      if (fresh && isJobBusy(fresh.status)) {
        logger.warn("enqueue rejected — busy in DB", {
          key,
          jobId: job.id,
          status: fresh.status,
          currentJobIds: this.currentJobIds,
        });
        return { enqueued: false, reason: "Issue already queued or running" };
      }
    }

    job.issue = issue;
    job.status = "queued";
    job.error = undefined;
    job.clarifyRound = 0;
    job.lastQuestion = undefined;
    job.handedOffAt = undefined;

    // Pin ownership once — do not rebind workspace/base when switching projects.
    if (rt) {
      if (!job.ownerUsername) job.ownerUsername = rt.gitlabUsername;
      if (!job.workspaceProjectId?.trim()) {
        job.workspaceProjectId = rt.projectId;
      }
      job.flowTaskId = job.id;
      if (!job.baseBranch?.trim() && rt.baseBranch) {
        job.baseBranch = rt.baseBranch;
      }
      if (!job.workBranch?.trim() && rt.workBranch?.trim()) {
        job.workBranch = rt.workBranch.trim();
      }
    }

    this.activeIssueKeys.add(busyIssueKeyForJob(job));
    this.rememberJobScope(job);
    if (opts?.source) this.sources.set(job.id, opts.source);
    this.queue.push({
      job,
      source: opts?.source,
      forceCodePhase: opts?.forceCodePhase,
    });
    await saveJob(job, { source: opts?.source });
    this.publishStatus("enqueue");
    const snap = this.snapshot();
    logger.info("Enqueued job", {
      jobId: job.id,
      key: busyIssueKeyForJob(job),
      iid: job.issue.issueIid,
      source: opts?.source,
      runCount: job.runCount,
      requireDocsFirst: job.requireDocsFirst,
      forceCodePhase: opts?.forceCodePhase,
      ownerUsername: job.ownerUsername,
      workspaceProjectId: job.workspaceProjectId,
      queueLength: snap.queued,
      pumpRunning: snap.running,
      currentJobId: snap.currentJobId,
    });
    void this.pump();
    return { enqueued: true, jobId: job.id };
  }

  /** Enqueue existing draft/terminal jobs (Run all drafts). */
  async enqueueExisting(
    jobId: string,
    opts?: { source?: string; completion?: CompletionActions },
  ): Promise<{ enqueued: boolean; reason?: string; jobId?: string }> {
    const job = await loadJob(jobId);
    if (!job) return { enqueued: false, reason: "Job not found" };
    return this.enqueue(job.issue, {
      source: opts?.source ?? "rerun",
      completion: opts?.completion ?? job.completion,
      devNotes: resolveDevNotes(job) || undefined,
      requireDocsFirst: job.requireDocsFirst,
    });
  }

  /** After PM approves feature docs → enqueue code phase. */
  async enqueueCodeAfterDocsApproval(
    jobId: string,
  ): Promise<{ enqueued: boolean; reason?: string; jobId?: string }> {
    const job = await loadJob(jobId);
    if (!job) return { enqueued: false, reason: "Job not found" };
    if (job.status !== "awaiting_docs_approval") {
      return {
        enqueued: false,
        reason: "Job is not awaiting_docs_approval",
      };
    }
    job.docsApprovedAt = new Date().toISOString();
    await saveJob(job);
    return this.enqueue(job.issue, {
      source: "docs_approved",
      completion: job.completion,
      devNotes: resolveDevNotes(job) || undefined,
      requireDocsFirst: job.requireDocsFirst,
      forceCodePhase: true,
    });
  }

  /**
   * Enqueue an IDE follow-up command from chat **Send**.
   * Returns immediately after queuing so the HTTP client does not wait
   * for Cursor (avoids the 120s axios timeout). The pump runs the agent.
   */
  async followUpChat(
    jobId: string,
    message: string,
  ): Promise<{
    ok: boolean;
    queued?: boolean;
    job: JobRecord;
    kind: string;
    question?: string;
  }> {
    const msg = message.trim();
    if (!msg) throw new Error("message required");

    const loaded = await loadJob(jobId);
    if (!loaded) throw new Error("Job not found");
    let job: JobRecord = loaded;

    // Orphaned busy (no in-memory Cursor run) — reclaim so user can retry
    if (isJobBusy(job.status) && !hasActiveAgentRun(jobId)) {
      const reclaimTo: JobStatus = job.handedOffAt
        ? "succeeded"
        : job.completedAt
          ? "awaiting_handoff"
          : "draft";
      logger.warn("Reclaiming orphaned busy job before follow-up enqueue", {
        jobId,
        from: job.status,
        to: reclaimTo,
        currentJobIds: this.currentJobIds,
      });
      job.status = reclaimTo;
      job.error =
        job.error ||
        "Previous agent run was stuck / interrupted — reclaimed for retry";
      job.pendingFollowUpMessage = undefined;
      await saveJob(job);
      if (this.isCurrent(jobId)) {
        this.clearCurrent(jobId);
        this.publishStatus();
      }
    }

    if (hasActiveAgentRun(jobId) || isJobBusy(job.status)) {
      throw new Error(
        "Agent is running on this job — wait for it to finish or Force Stop, then send again",
      );
    }

    const key = busyIssueKeyForJob(job);
    if (this.activeIssueKeys.has(key) || this.queue.some((q) => q.job.id === job.id)) {
      throw new Error(
        "Agent is running on this job — wait for it to finish or Force Stop, then send again",
      );
    }

    const notes = resolveDevNotes(job);
    let priorChat: Awaited<ReturnType<typeof listChatMessages>> = [];
    try {
      priorChat = await listChatMessages({ jobId: job.id, limit: 40 });
    } catch {
      /* ignore */
    }
    const quality = resolveContextQualityForCoding(job, {
      devNotes: notes || undefined,
      chatHuman: priorChat
        .filter((m) => m.role === "user" && m.body?.trim())
        .map((m) => m.body),
      extraHuman: msg,
    });

    // Save user message immediately — UI shows it before the agent starts
    await addChatMessage({
      jobId: job.id,
      issueIid: job.issue.issueIid,
      role: "user",
      kind: "qa",
      body: msg,
    });

    if (!quality.cached) {
      job.contextQuality = toContextQualityMark(quality);
      await saveJob(job);
    }
    logger.info("Context quality for follow-up enqueue", {
      jobId,
      level: quality.level,
      cached: Boolean(quality.cached),
    });
    if (quality.level === "bad") {
      const body = formatBadContextChatMessage(quality, job.issue.issueIid);
      await addChatMessage({
        jobId: job.id,
        issueIid: job.issue.issueIid,
        role: "agent",
        kind: "clarify",
        body,
      });
      job.lastQuestion = body;
      job.error = "Bad Context — add more information before agent coding";
      job.contextQuality = toContextQualityMark(quality);
      await saveJob(job);
      appendJobProgress(
        job.id,
        "status",
        "Bad Context — không gọi Cursor Agent (follow-up)",
      );
      return { ok: false, job, kind: "bad_context", question: body };
    }

    const budgetError = this.tokenBudgetError(job);
    if (budgetError) throw new Error(budgetError);

    const restoreStatus = job.status;
    job.pendingFollowUpMessage = msg;
    job.pendingFollowUpKind = "send";
    job.followUpRestoreStatus = restoreStatus;
    job.status = "queued";
    job.error = undefined;
    await saveJob(job);

    this.activeIssueKeys.add(key);
    this.rememberJobScope(job);
    this.sources.set(job.id, "chat_followup");
    this.queue.push({
      job,
      source: "chat_followup",
      followUpMessage: msg,
      followUpRestoreStatus: restoreStatus,
    });
    this.publishStatus("enqueue-followup");

    appendJobProgress(job.id, "status", "Follow-up queued (chat Send)");

    logger.info("Enqueued chat follow-up", {
      jobId: job.id,
      iid: job.issue.issueIid,
      queueLength: this.queue.length,
      msgPreview: msg.slice(0, 120),
    });
    void this.pump();
    return { ok: true, queued: true, job, kind: "queued" };
  }

  /**
   * Enqueue Ask only (Q&A / review — no coding). Same async queue as Send/Run
   * so HTTP does not wait for Cursor.
   */
  async askOnlyChat(
    jobId: string,
    question: string,
  ): Promise<{
    ok: boolean;
    queued?: boolean;
    job: JobRecord;
    kind: string;
  }> {
    const msg = question.trim();
    if (!msg) throw new Error("question required");

    const loaded = await loadJob(jobId);
    if (!loaded) throw new Error("Job not found");
    let job: JobRecord = loaded;

    if (isJobBusy(job.status) && !hasActiveAgentRun(jobId)) {
      const reclaimTo: JobStatus = job.handedOffAt
        ? "succeeded"
        : job.completedAt
          ? "awaiting_handoff"
          : "draft";
      logger.warn("Reclaiming orphaned busy job before ask enqueue", {
        jobId,
        from: job.status,
        to: reclaimTo,
      });
      job.status = reclaimTo;
      job.error =
        job.error ||
        "Previous agent run was stuck / interrupted — reclaimed for retry";
      job.pendingFollowUpMessage = undefined;
      await saveJob(job);
      if (this.isCurrent(jobId)) {
        this.clearCurrent(jobId);
        this.publishStatus();
      }
    }

    if (hasActiveAgentRun(jobId) || isJobBusy(job.status)) {
      throw new Error(
        "Agent is running on this job — wait for it to finish or Force Stop, then ask again",
      );
    }

    const key = busyIssueKeyForJob(job);
    if (
      this.activeIssueKeys.has(key) ||
      this.queue.some((q) => q.job.id === job.id)
    ) {
      throw new Error(
        "Agent is running on this job — wait for it to finish or Force Stop, then ask again",
      );
    }

    await addChatMessage({
      jobId: job.id,
      issueIid: job.issue.issueIid,
      role: "user",
      kind: "qa",
      body: msg,
    });

    const restoreStatus = job.status;
    job.pendingFollowUpMessage = msg;
    job.pendingFollowUpKind = "ask";
    job.followUpRestoreStatus = restoreStatus;
    job.status = "queued";
    job.error = undefined;
    await saveJob(job);

    this.activeIssueKeys.add(key);
    this.rememberJobScope(job);
    this.sources.set(job.id, "chat_ask");
    this.queue.push({
      job,
      source: "chat_ask",
      askOnlyMessage: msg,
      followUpRestoreStatus: restoreStatus,
    });
    this.publishStatus("enqueue-ask");

    appendJobProgress(job.id, "status", "Ask only queued");

    logger.info("Enqueued chat ask-only", {
      jobId: job.id,
      iid: job.issue.issueIid,
      queueLength: this.queue.length,
      msgPreview: msg.slice(0, 120),
    });
    void this.pump();
    return { ok: true, queued: true, job, kind: "queued" };
  }

  /**
   * Run a queued chat follow-up (called from pump — not from HTTP).
   */
  private async executeFollowUpChat(
    jobIn: JobRecord,
    message: string,
    opts?: { restoreStatus?: JobStatus },
  ): Promise<void> {
    const msg = message.trim();
    const loaded = await loadJob(jobIn.id);
    if (!loaded) throw new Error("Job not found");
    let job: JobRecord = loaded;

    const prevStatus: JobStatus =
      opts?.restoreStatus ||
      job.followUpRestoreStatus ||
      (job.handedOffAt
        ? "succeeded"
        : job.completedAt
          ? "awaiting_handoff"
          : "draft");
    const wasDone =
      prevStatus === "awaiting_handoff" || prevStatus === "succeeded";
    const key = busyIssueKeyForJob(job);

    job.pendingFollowUpMessage = undefined;
    job.pendingFollowUpKind = undefined;
    job.followUpRestoreStatus = undefined;
    this.activeIssueKeys.add(key);
    this.setCurrent(job);
    this.publishStatus();
    job.status = "running";
    job.error = undefined;
    await saveJob(job);

    const notes = resolveDevNotes(job);
    let priorChat: Awaited<ReturnType<typeof listChatMessages>> = [];
    try {
      priorChat = await listChatMessages({ jobId: job.id, limit: 40 });
    } catch {
      /* ignore */
    }
    const quality = resolveContextQualityForCoding(job, {
      devNotes: notes || undefined,
      chatHuman: priorChat
        .filter((m) => m.role === "user" && m.body?.trim())
        .map((m) => m.body),
      extraHuman: msg,
    });
    if (!quality.cached) {
      job.contextQuality = toContextQualityMark(quality);
      await saveJob(job);
    }
    const contextQualityBlock = formatContextQualityForPrompt(quality);

    // Opt-in Sheets/Excel — same as Run (only if user checked boxes)
    let googleSheetsBlock = "";
    try {
      const { prepareGoogleSheetsForJob } = await import(
        "./modules/google/index.js"
      );
      const sheetsPrep = await prepareGoogleSheetsForJob(
        job,
        [...priorChat.map((m) => m.body || ""), msg],
      );
      if (sheetsPrep.gate) {
        logger.info("follow-up pause — awaiting Google Sheets auth", {
          jobId: job.id,
        });
        appendJobProgress(
          job.id,
          "status",
          "Awaiting Google authorization for Sheets",
        );
        this.activeIssueKeys.delete(key);
        this.clearCurrent(job.id);
        this.publishStatus();
        return;
      }
      googleSheetsBlock = sheetsPrep.promptBlock || "";
    } catch (err) {
      logger.warn("Google Sheets prep failed on follow-up — continue without", {
        jobId: job.id,
        err: String(err),
      });
    }

    const runFollowUp = async (): Promise<void> => {
      const rt = getRuntimeContext();
      const repoPath = rt?.repoPath?.trim();
      if (!repoPath) throw new Error("No repo path in workspace context");

      const fixedWork = (job.workBranch || rt?.workBranch || "").trim();
      const prepared = await prepareRepoForIssue({
        issueIid: Math.max(job.issue.issueIid, 0),
        title: job.issue.title,
        baseBranch: job.baseBranch || rt?.baseBranch,
        workBranch: fixedWork || (job.kind === "adhoc" ? job.branch : undefined),
        // Missing work branch → create from Main / base
        createWorkBranchIfMissing: true,
        repoPath,
      });
      job.branch = fixedWork || prepared.branch;
      if (fixedWork) job.workBranch = fixedWork;
      await saveJob(job);

      const chatHistory = priorChat
        .map((m) => {
          const who =
            m.role === "user" ? "Human" : m.role === "agent" ? "Agent" : "System";
          const body = String(m.body || "").trim().slice(0, 2500);
          return body ? `${who}:\n${body}` : "";
        })
        .filter(Boolean)
        .join("\n\n")
        .slice(0, 24_000);

      const headBefore = await getHeadSha(repoPath);
      const result = await this.runAgentWithRetry(job, () =>
        continueAgentWindow(job.issue, msg, {
          jobId: job.id,
          chatHistory: chatHistory || undefined,
          contextQualityBlock,
          googleSheetsBlock: googleSheetsBlock || undefined,
        }),
      );
      job.agentId = result.agentId;
      applyTokenUsageToJob(job, result.usage);
      await saveJob(job);

      await this.deliverAgentGitlabComments(job, result.text);

      const chatBody = extractChatBodyFromAgentText(result.text, {
        summary: result.summary,
        question: result.question,
      });
      await addChatMessage({
        jobId: job.id,
        issueIid: job.issue.issueIid,
        role: "agent",
        kind: "qa",
        body: chatBody,
      });

      if (result.kind === "need_clarification") {
        job.status = "awaiting_clarification";
        job.lastQuestion = result.question ?? chatBody;
        job.error = undefined;
        job.clarifyRound = (job.clarifyRound ?? 0) + 1;
        await saveJob(job);
        return;
      }

      // Follow-up may have edited code — same verify + self-heal gate as Run
      await this.verifyAndSelfHeal(job, repoPath, headBefore);

      const { hasChange } = await this.finalizeOrDeferCommit(
        job,
        repoPath,
        headBefore,
        commitMessageForIssue(job.issue),
      );

      if (result.summary) job.summary = result.summary;

      if (wasDone && !hasChange) {
        job.status = prevStatus;
      } else {
        job.status = "awaiting_handoff";
        job.completedAt = new Date().toISOString();
      }
      job.error = undefined;
      await saveJob(job);

      logger.info("IDE follow-up finished", {
        jobId: job.id,
        kind: result.kind,
        hasChange,
        resumed: result.resumed,
        agentId: job.agentId,
        prevStatus,
        status: job.status,
      });
    };

    try {
      if (job.ownerUsername && job.workspaceProjectId) {
        await withWorkspaceContext(
          job.ownerUsername,
          job.workspaceProjectId,
          runFollowUp,
        );
      } else {
        await runFollowUp();
      }
    } catch (err) {
      const errMsg = isStartupError(err)
        ? `Cursor SDK startup error: ${err.message}`
        : err instanceof Error
          ? err.message
          : String(err);

      if (/Force-stopped|force stop|cancelled \(force/i.test(errMsg)) {
        const fresh = await loadJob(job.id);
        if (fresh && !isJobBusy(fresh.status)) {
          job = fresh;
        } else {
          job.status = wasDone ? prevStatus : "draft";
          job.agentId = undefined;
          job.error = "Force-stopped from UI";
          await saveJob(job);
        }
        await this.notifyJobChat(job, "Đã Force Stop — agent dừng giữa chừng.");
        return;
      }

      if (wasDone) {
        job.status = prevStatus;
        job.agentId = undefined;
      } else {
        if (isTransientCursorTransportError(err)) {
          job.status = prevStatus;
          job.agentId = undefined;
        } else {
          job.status = "failed";
        }
      }
      job.error = errMsg;
      await saveJob(job);
      await this.notifyJobChat(job, `Chat lỗi:\n${errMsg}`);
      logger.error("IDE follow-up failed", { jobId: job.id, err: errMsg });
    } finally {
      job.pendingFollowUpMessage = undefined;
      job.pendingFollowUpKind = undefined;
      job.followUpRestoreStatus = undefined;
      this.activeIssueKeys.delete(key);
      if (this.isCurrent(job.id)) {
        this.clearCurrent(job.id);
        this.publishStatus();
      }
      this.killedJobs.delete(job.id);
      const { clearJobKillRequested } = await import("./plugins/agent/run.js");
      clearJobKillRequested(job.id);
      publishRealtime({ type: "jobs", reason: "followup-done" });
    }
  }

  /** Run queued Ask only (Q&A) from pump. */
  private async executeAskOnlyChat(
    jobIn: JobRecord,
    question: string,
    opts?: { restoreStatus?: JobStatus },
  ): Promise<void> {
    const msg = question.trim();
    const loaded = await loadJob(jobIn.id);
    if (!loaded) throw new Error("Job not found");
    let job: JobRecord = loaded;

    const prevStatus: JobStatus =
      opts?.restoreStatus ||
      job.followUpRestoreStatus ||
      (job.handedOffAt
        ? "succeeded"
        : job.completedAt
          ? "awaiting_handoff"
          : "draft");
    const key = busyIssueKeyForJob(job);

    job.pendingFollowUpMessage = undefined;
    job.pendingFollowUpKind = undefined;
    job.followUpRestoreStatus = undefined;
    this.activeIssueKeys.add(key);
    this.setCurrent(job);
    this.publishStatus();
    job.status = "running";
    job.error = undefined;
    await saveJob(job);

    let priorChat: Awaited<ReturnType<typeof listChatMessages>> = [];
    try {
      priorChat = await listChatMessages({ jobId: job.id, limit: 40 });
    } catch {
      /* ignore */
    }

    const runAsk = async (): Promise<void> => {
      const qa = await this.runAgentWithRetry(job, () =>
        answerTaskQuestion({
          issue: job.issue,
          question: msg,
          jobId: job.id,
          existingAgentId: job.agentId,
          history: priorChat.map((m) => ({
            role: m.role,
            kind: m.kind,
            body: m.body,
          })),
        }),
      );
      job.agentId = qa.agentId;
      applyTokenUsageToJob(job, qa.usage);
      job.status = prevStatus;
      job.error = undefined;
      await saveJob(job);
      await addChatMessage({
        jobId: job.id,
        issueIid: job.issue.issueIid,
        role: "agent",
        kind: "qa",
        body: qa.answer,
      });
      logger.info("Ask only finished", {
        jobId: job.id,
        resumed: qa.resumed,
        status: job.status,
      });
    };

    try {
      if (job.ownerUsername && job.workspaceProjectId) {
        await withWorkspaceContext(
          job.ownerUsername,
          job.workspaceProjectId,
          runAsk,
        );
      } else {
        await runAsk();
      }
    } catch (err) {
      const errMsg = isStartupError(err)
        ? `Cursor SDK startup error: ${err.message}`
        : err instanceof Error
          ? err.message
          : String(err);

      if (/Force-stopped|force stop|cancelled \(force/i.test(errMsg)) {
        const fresh = await loadJob(job.id);
        if (fresh && !isJobBusy(fresh.status)) {
          job = fresh;
        } else {
          job.status = prevStatus;
          job.agentId = undefined;
          job.error = "Force-stopped from UI";
          await saveJob(job);
        }
        await this.notifyJobChat(job, "Đã Force Stop — Ask only dừng giữa chừng.");
        return;
      }

      job.status = prevStatus;
      job.error = errMsg;
      await saveJob(job);
      await this.notifyJobChat(job, `Ask only lỗi:\n${errMsg}`);
      logger.error("Ask only failed", { jobId: job.id, err: errMsg });
    } finally {
      job.pendingFollowUpMessage = undefined;
      job.pendingFollowUpKind = undefined;
      job.followUpRestoreStatus = undefined;
      this.activeIssueKeys.delete(key);
      if (this.isCurrent(job.id)) {
        this.clearCurrent(job.id);
        this.publishStatus();
      }
      this.killedJobs.delete(job.id);
      const { clearJobKillRequested } = await import("./plugins/agent/run.js");
      clearJobKillRequested(job.id);
      publishRealtime({ type: "jobs", reason: "ask-done" });
    }
  }

  /**
   * Force-stop: cancel Cursor run, reject waiters, mark failed, free queue slot.
   */
  async killJob(
    jobId: string,
    reason = "Force-stopped from UI",
  ): Promise<{
    ok: boolean;
    phase: string;
    agentCancelled?: boolean;
  }> {
    this.killedJobs.add(jobId);
    const { markJobKillRequested, clearJobKillRequested } = await import(
      "./plugins/agent/run.js"
    );
    markJobKillRequested(jobId);

    const queuedIdx = this.queue.findIndex((q) => q.job.id === jobId);
    if (queuedIdx >= 0) {
      const [item] = this.queue.splice(queuedIdx, 1);
      const key = busyIssueKeyForJob(item.job);
      const restore =
        item.followUpRestoreStatus || item.job.followUpRestoreStatus;
      if ((item.followUpMessage || item.askOnlyMessage) && restore) {
        item.job.status = restore;
        item.job.error = reason;
      } else {
        item.job.status = "failed";
        item.job.error = reason;
      }
      item.job.agentId = undefined;
      item.job.pendingFollowUpMessage = undefined;
      item.job.pendingFollowUpKind = undefined;
      item.job.followUpRestoreStatus = undefined;
      await saveJob(item.job);
      await this.notifyJobChat(
        item.job,
        item.askOnlyMessage
          ? `Đã hủy Ask only trong hàng chờ:\n${reason}`
          : item.followUpMessage
            ? `Đã hủy lệnh chat trong hàng chờ:\n${reason}`
            : `Đã hủy job trong hàng chờ:\n${reason}`,
      );
      this.activeIssueKeys.delete(key);
      this.killedJobs.delete(jobId);
      clearJobKillRequested(jobId);
      this.publishStatus("kill-queued");
      logger.warn("Killed queued job", {
        jobId,
        reason,
        followUp: Boolean(item.followUpMessage),
      });
      return { ok: true, phase: "queued" };
    }

    cancelDiffApproval(jobId, reason);
    const agentCancelled = await cancelActiveAgentRun(jobId);

    const { getJobDoc } = await import("./db/mongo.js");
    const doc = await getJobDoc(jobId);
    if (doc) {
      const job = { ...doc } as JobRecord & { _id?: string; source?: string };
      delete job._id;
      delete job.source;
      if (
        isJobBusy(job.status) ||
        job.status === "awaiting_clarification" ||
        job.status === "awaiting_diff_approval" ||
        job.status === "awaiting_docs_approval"
      ) {
        // Follow-up kill on already-done work → restore handoff/done, don't force failed
        if (job.handedOffAt) {
          job.status = "succeeded";
        } else if (job.completedAt) {
          job.status = "awaiting_handoff";
        } else {
          job.status = "failed";
        }
        job.error = reason;
        // Detach Cursor window — resume after Force Stop often fails
        job.agentId = undefined;
        await saveJob(job);
        this.activeIssueKeys.delete(busyIssueKeyForJob(job));
      }
    }

    if (this.isCurrent(jobId)) {
      // Clear immediately so UI Idle / status SSE don't stay "Running …"
      // while Cursor cancel / executeJob.finally still unwind.
      this.clearCurrent(jobId);
      this.publishStatus("kill-running");
      logger.warn("Kill signal sent to running job", {
        jobId,
        agentCancelled,
        reason,
      });
      return { ok: true, phase: "running", agentCancelled };
    }

    // Stale "Running" in UI: job not current but still busy in DB — status already updated above
    this.publishStatus("kill");
    if (doc) {
      return {
        ok: true,
        phase: doc.status,
        agentCancelled,
      };
    }

    this.killedJobs.delete(jobId);
    clearJobKillRequested(jobId);
    return { ok: false, phase: "not_found_or_terminal" };
  }

  /**
   * Force-stop all queued + running jobs (optionally scoped to workspace project).
   * Also picks up DB rows still marked queued/running (stuck after crash/hang).
   */
  async killAllJobs(opts?: {
    workspaceProjectId?: string;
    ownerUsername?: string;
    reason?: string;
  }): Promise<{
    ok: boolean;
    killed: number;
    attempted: number;
    jobIds: string[];
    results: Array<{ jobId: string; ok: boolean; phase?: string }>;
  }> {
    const reason = opts?.reason?.trim() || "Kill all from UI";
    const projectId = opts?.workspaceProjectId?.trim();
    const owner = opts?.ownerUsername?.trim();

    const inScope = (job: Pick<JobRecord, "workspaceProjectId" | "ownerUsername">) => {
      if (projectId && job.workspaceProjectId !== projectId) return false;
      if (owner && job.ownerUsername && job.ownerUsername !== owner) return false;
      return true;
    };

    const ids = new Set<string>();

    for (const item of this.queue) {
      if (inScope(item.job)) ids.add(item.job.id);
    }
    for (const jobId of this.currentJobIds) {
      const doc = await loadJob(jobId);
      if (!doc || inScope(doc)) ids.add(jobId);
    }

    const { listJobDocs } = await import("./db/mongo.js");
    const docs = await listJobDocs({
      workspaceProjectId: projectId,
      ownerUsername: owner,
      limit: 200,
    });
    for (const doc of docs) {
      if (!isJobBusy(doc.status)) continue;
      if (inScope(doc)) ids.add(doc.id);
    }

    const results: Array<{ jobId: string; ok: boolean; phase?: string }> = [];
    for (const jobId of ids) {
      const r = await this.killJob(jobId, reason);
      results.push({ jobId, ok: r.ok, phase: r.phase });
    }

    this.publishStatus("kill-all");
    return {
      ok: true,
      killed: results.filter((r) => r.ok).length,
      attempted: results.length,
      jobIds: [...ids],
      results,
    };
  }

  /**
   * Drop Cursor agent window for this job.
   * Stops any active run first, clears `agentId` so next Run / chat / Q&A
   * opens a fresh window (prior Mongo chat still injected into prompt).
   */
  async resetAgentWindow(jobId: string): Promise<{
    ok: boolean;
    killed: boolean;
    previousAgentId?: string;
    job: JobRecord;
  }> {
    const loaded = await loadJob(jobId);
    if (!loaded) throw new Error("Job not found");

    const previousAgentId = loaded.agentId;
    let killed = false;

    if (
      hasActiveAgentRun(jobId) ||
      isJobBusy(loaded.status) ||
      loaded.status === "awaiting_diff_approval" ||
      loaded.status === "awaiting_docs_approval" ||
      this.queue.some((q) => q.job.id === jobId)
    ) {
      const kill = await this.killJob(
        jobId,
        "Reset agent window — stopped before opening a new window",
      );
      killed = kill.ok;
    }

    const job = (await loadJob(jobId)) || loaded;
    const hadWindow = Boolean(job.agentId || previousAgentId);
    job.agentId = undefined;
    // Idle after kill left "failed" — soft reset to draft so user can Run again
    if (job.status === "failed" && !job.completedAt && !job.handedOffAt) {
      job.status = "draft";
      job.error = undefined;
    }
    await saveJob(job);

    await addChatMessage({
      jobId: job.id,
      issueIid: job.issue.issueIid,
      role: "system",
      kind: "note",
      body: hadWindow
        ? `🔄 Đã reset agent window${
            previousAgentId ? ` (cũ: ${previousAgentId.slice(0, 20)}…)` : ""
          }. Run / Gửi / Q&A tiếp theo sẽ mở cửa sổ mới. Chat lịch sử vẫn giữ để inject prompt.`
        : "🔄 Đã reset agent window (chưa có window gắn job). Run / Gửi tiếp theo mở cửa sổ mới.",
    });

    appendJobProgress(
      job.id,
      "status",
      previousAgentId
        ? `Reset window — bỏ ${previousAgentId.slice(0, 18)}…`
        : "Reset window — sẵn sàng cửa sổ mới",
    );

    logger.info("Agent window reset", {
      jobId,
      previousAgentId,
      killed,
      status: job.status,
    });

    return {
      ok: true,
      killed,
      previousAgentId,
      job,
    };
  }

  private assertNotKilled(job: JobRecord) {
    if (this.killedJobs.has(job.id)) {
      throw new Error(job.error || "Force-stopped from UI");
    }
  }

  /** Non-null message when JOB_TOKEN_BUDGET is set and this job exceeded it. */
  private tokenBudgetError(job: JobRecord): string | null {
    const budget = getConfig().JOB_TOKEN_BUDGET;
    if (!budget || budget <= 0) return null;
    const used = job.tokenUsage?.totalTokens ?? 0;
    if (used < budget) return null;
    return `Job đã dùng ${used.toLocaleString()} tokens — vượt ngân sách ${budget.toLocaleString()} (JOB_TOKEN_BUDGET). Reset agent window hoặc tăng budget để chạy tiếp.`;
  }

  /** Retry transient Cursor transport errors with linear backoff. */
  private async runAgentWithRetry<T>(
    job: JobRecord,
    fn: () => Promise<T>,
  ): Promise<T> {
    const max = Math.max(0, getConfig().AGENT_TRANSIENT_RETRIES);
    let attempt = 0;
    while (true) {
      try {
        return await fn();
      } catch (err) {
        if (
          !isTransientCursorTransportError(err) ||
          attempt >= max ||
          this.killedJobs.has(job.id)
        ) {
          throw err;
        }
        attempt += 1;
        const delayMs = attempt * 5000;
        appendJobProgress(
          job.id,
          "status",
          `Lỗi mạng Cursor tạm thời — tự retry ${attempt}/${max} sau ${delayMs / 1000}s`,
        );
        logger.warn("Transient Cursor error — retrying", {
          jobId: job.id,
          attempt,
          max,
          err: String(err),
        });
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }

  /**
   * Run VERIFY_COMMAND (project or env) after the code phase; on failure,
   * give the agent ONE self-heal round, then re-verify. Never blocks the
   * commit — a persistent failure is surfaced in chat for human review.
   */
  private async verifyAndSelfHeal(
    job: JobRecord,
    repoPath: string,
    headBefore: string | null,
  ): Promise<void> {
    const config = getConfig();
    const rt = getRuntimeContext();
    const command = (rt?.verifyCommand || config.VERIFY_COMMAND || "").trim();
    if (!command || this.killedJobs.has(job.id)) return;

    // Only verify when the agent actually changed something
    const headNow = await getHeadSha(repoPath);
    const dirty = await hasUncommittedChanges(repoPath);
    const changed = dirty || (headBefore && headNow && headBefore !== headNow);
    if (!changed) return;

    appendJobProgress(job.id, "status", `Verify: ${command}`);
    let check = await runVerifyCommand(repoPath, command, {
      timeoutSec: config.VERIFY_TIMEOUT_SEC,
    });
    if (check.ok) {
      appendJobProgress(job.id, "status", "Verify PASS");
      return;
    }

    this.assertNotKilled(job);
    appendJobProgress(
      job.id,
      "status",
      "Verify FAIL — agent tự sửa (1 vòng self-heal)",
    );
    logger.warn("Verify failed — starting self-heal round", {
      jobId: job.id,
      command,
      exitCode: check.exitCode,
    });

    const fixMessage = [
      `The verification command failed after your changes. Fix the errors, then stop.`,
      ``,
      `Command: ${command}`,
      `Exit code: ${check.exitCode ?? "timeout"}`,
      ``,
      `Output (tail):`,
      "```",
      check.output.slice(-4000),
      "```",
      ``,
      `Rules: only fix what the errors point to — no refactors, no new features.`,
      `Reply with the <<<DONE>>> block when fixed.`,
    ].join("\n");

    try {
      const fix = await this.runAgentWithRetry(job, () =>
        continueAgentWindow(job.issue, fixMessage, { jobId: job.id }),
      );
      job.agentId = fix.agentId;
      applyTokenUsageToJob(job, fix.usage);
      await saveJob(job);
    } catch (err) {
      logger.warn("Self-heal agent round failed", {
        jobId: job.id,
        err: err instanceof Error ? err.message : String(err),
      });
    }

    check = await runVerifyCommand(repoPath, command, {
      timeoutSec: config.VERIFY_TIMEOUT_SEC,
    });
    if (check.ok) {
      appendJobProgress(job.id, "status", "Verify PASS (sau self-heal)");
      await this.notifyJobChat(
        job,
        `✅ Verify \`${command}\` PASS sau 1 vòng agent tự sửa.`,
      );
      return;
    }

    appendJobProgress(job.id, "status", "Verify vẫn FAIL — cần review tay");
    await this.notifyJobChat(
      job,
      `⚠️ Verify \`${command}\` vẫn FAIL sau 1 vòng self-heal (exit ${check.exitCode ?? "timeout"}).\n\n\`\`\`\n${check.output.slice(-1500)}\n\`\`\`\n\nCommit vẫn được tạo — review kỹ trước khi handoff.`,
    );
  }

  /** Surface Run / chat problems in the Agent console so the user always sees them. */
  private async notifyJobChat(
    job: Pick<JobRecord, "id" | "issue">,
    body: string,
  ): Promise<void> {
    const text = body.trim();
    if (!text) return;
    try {
      await addChatMessage({
        jobId: job.id,
        issueIid: job.issue.issueIid,
        role: "system",
        kind: "note",
        body: text,
      });
    } catch (err) {
      logger.warn("Could not post issue to job chat", {
        jobId: job.id,
        err: String(err),
      });
    }
  }

  /**
   * Start one worker per lane (workspace project + owner) that has queued items.
   * Different users/projects run in parallel; one user's jobs on a project stay serial.
   */
  private async pump() {
    const lanes = new Set(this.queue.map((q) => this.laneKeyFor(q.job)));
    for (const lane of lanes) {
      if (this.runningLanes.has(lane)) continue;
      this.runningLanes.add(lane);
      void this.pumpLane(lane)
        .catch((err) => {
          logger.error("pump lane crashed (unexpected)", {
            lane,
            err: err instanceof Error ? err.message : String(err),
          });
        })
        .finally(() => {
          this.runningLanes.delete(lane);
          this.publishStatus();
          // Race: an item for this lane may have arrived while unwinding
          if (this.queue.some((q) => this.laneKeyFor(q.job) === lane)) {
            logger.warn("pump re-kick — jobs arrived during lane shutdown", {
              lane,
            });
            void this.pump();
          }
        });
    }
  }

  private async pumpLane(lane: string) {
    logger.info("pump lane start", {
      lane,
      queueLength: this.queue.length,
      queuedIds: this.queue.map((q) => q.job.id),
    });
    while (true) {
      const idx = this.queue.findIndex(
        (q) => this.laneKeyFor(q.job) === lane,
      );
      if (idx < 0) break;
      const [item] = this.queue.splice(idx, 1);
      logger.info("pump dequeue", {
        lane,
        jobId: item.job.id,
        iid: item.job.issue.issueIid,
        remaining: this.queue.length,
        forceCodePhase: Boolean(item.forceCodePhase),
        followUp: Boolean(item.followUpMessage),
        askOnly: Boolean(item.askOnlyMessage),
        source: item.source,
      });
      try {
        if (item.followUpMessage) {
          await this.executeFollowUpChat(item.job, item.followUpMessage, {
            restoreStatus: item.followUpRestoreStatus,
          });
        } else if (item.askOnlyMessage) {
          await this.executeAskOnlyChat(item.job, item.askOnlyMessage, {
            restoreStatus: item.followUpRestoreStatus,
          });
        } else {
          await this.runJob(item.job, { forceCodePhase: item.forceCodePhase });
        }
        logger.info("pump job finished", {
          lane,
          jobId: item.job.id,
          status: item.job.status,
          remaining: this.queue.length,
        });
      } catch (err) {
        // runJob/executeJob should catch; this is a last resort so the pump continues
        logger.error("pump job threw (unexpected)", {
          lane,
          jobId: item.job.id,
          err: err instanceof Error ? err.message : String(err),
          remaining: this.queue.length,
        });
        const key = busyIssueKeyForJob(item.job);
        this.activeIssueKeys.delete(key);
        this.clearCurrent(item.job.id);
      }
    }
    logger.info("pump lane idle", { lane });
  }

  private async deliverAgentGitlabComments(
    job: JobRecord,
    agentText: string,
  ): Promise<number> {
    try {
      const posted = await postAgentGitlabComments({
        projectId: job.issue.projectId,
        issueIid: job.issue.issueIid,
        agentText,
        jobId: job.id,
      });
      if (posted.posted > 0) {
        await addChatMessage({
          jobId: job.id,
          issueIid: job.issue.issueIid,
          role: "system",
          kind: "note",
          body: `Đã đăng ${posted.posted} comment lên GitLab #${job.issue.issueIid} (AI-Generated).`,
        });
      }
      return posted.posted;
    } catch (err) {
      await addChatMessage({
        jobId: job.id,
        issueIid: job.issue.issueIid,
        role: "system",
        kind: "note",
        body: `Đăng comment GitLab thất bại: ${
          err instanceof Error ? err.message : String(err)
        }`,
      }).catch(() => undefined);
      return 0;
    }
  }

  /**
   * Agent asked for clarification — post to chat and pause.
   * User answers via normal chat (/continue); no blocking waiter.
   */
  private async pauseForChatClarification(
    job: JobRecord,
    result: Awaited<ReturnType<typeof runNewAgent>>,
  ): Promise<void> {
    const config = getConfig();
    await this.deliverAgentGitlabComments(job, result.text);

    job.clarifyRound = (job.clarifyRound ?? 0) + 1;
    if (job.clarifyRound > config.MAX_CLARIFY_ROUNDS) {
      throw new Error(
        `Exceeded MAX_CLARIFY_ROUNDS (${config.MAX_CLARIFY_ROUNDS})`,
      );
    }

    const question = result.question?.trim() || "(no question text)";
    const chatBody = extractChatBodyFromAgentText(result.text, {
      question,
      summary: result.summary,
    });
    job.status = "awaiting_clarification";
    job.lastQuestion = question;
    job.error = undefined;
    await saveJob(job);

    await addChatMessage({
      jobId: job.id,
      issueIid: job.issue.issueIid,
      role: "agent",
      kind: "qa",
      body: chatBody,
    });

    appendJobProgress(
      job.id,
      "status",
      "Agent hỏi — trả lời trong chat để tiếp tục",
    );
    logger.info("Job paused for chat clarification", {
      jobId: job.id,
      round: job.clarifyRound,
      preview: question.slice(0, 160),
    });
  }

  /**
   * Auto mode → GitLab Commits API; manual (default) → keep dirty tree for user Commit.
   */
  private async finalizeOrDeferCommit(
    job: JobRecord,
    repoPath: string,
    headBefore: string | null,
    commitMsg: string,
  ): Promise<{ commitSha: string | null; hasChange: boolean }> {
    this.assertNotKilled(job);
    if (resolveCommitMode(job) === "auto") {
      const result = await finalizeGitlabCommitForJob(
        job,
        repoPath,
        headBefore,
        commitMsg,
      );
      this.assertNotKilled(job);
      return result;
    }
    const deferred = await markPendingChangesIfDirty(
      job,
      repoPath,
      headBefore,
    );
    this.assertNotKilled(job);
    return {
      commitSha: job.commitSha ?? (await getHeadSha(repoPath)),
      hasChange: deferred.hasChange,
    };
  }

  private async runJob(
    job: JobRecord,
    opts?: { forceCodePhase?: boolean },
  ) {
    const execute = () => this.executeJob(job, opts);
    if (job.ownerUsername && job.workspaceProjectId) {
      logger.info("runJob bind workspace", {
        jobId: job.id,
        ownerUsername: job.ownerUsername,
        workspaceProjectId: job.workspaceProjectId,
      });
      try {
        await withWorkspaceContext(
          job.ownerUsername,
          job.workspaceProjectId,
          execute,
        );
      } catch (err) {
        logger.error("runJob workspace bind failed", {
          jobId: job.id,
          err: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
      return;
    }
    logger.warn("runJob without workspace bind", {
      jobId: job.id,
      ownerUsername: job.ownerUsername,
      workspaceProjectId: job.workspaceProjectId,
    });
    await execute();
  }

  private async executeJob(
    job: JobRecord,
    opts?: { forceCodePhase?: boolean },
  ) {
    const config = getConfig();
    const key = busyIssueKeyForJob(job);
    this.setCurrent(job);
    this.publishStatus();

    const rt = getRuntimeContext();
    logger.info("executeJob start", {
      jobId: job.id,
      key,
      iid: job.issue.issueIid,
      status: job.status,
      forceCodePhase: Boolean(opts?.forceCodePhase),
      requireDocsFirst: Boolean(job.requireDocsFirst),
      ownerUsername: job.ownerUsername,
      workspaceProjectId: job.workspaceProjectId,
      hasRuntime: Boolean(rt),
      repoPath: rt?.repoPath ? "(set)" : "(missing)",
      agentId: job.agentId ? `${job.agentId.slice(0, 8)}…` : null,
    });

    const repoPath = rt?.repoPath?.trim();
    if (!repoPath) {
      logger.warn("executeJob abort — no repo path", { jobId: job.id, key });
      job.status = "failed";
      job.error = "No repo path in workspace context";
      await saveJob(job);
      await this.notifyJobChat(
        job,
        "Run dừng: chưa có repo path trong workspace.\nVào Settings → Project để gắn PAT / Confirm clone.",
      );
      this.activeIssueKeys.delete(key);
      this.clearCurrent(job.id);
      this.publishStatus();
      return;
    }

    // Token budget gate — never start another agent round past the cap
    const budgetError = this.tokenBudgetError(job);
    if (budgetError) {
      logger.warn("executeJob abort — token budget exceeded", {
        jobId: job.id,
        totalTokens: job.tokenUsage?.totalTokens,
      });
      job.status = "draft";
      job.error = budgetError;
      await saveJob(job);
      await this.notifyJobChat(job, `⛔ ${budgetError}`);
      appendJobProgress(job.id, "status", "Token budget vượt hạn mức — dừng");
      this.activeIssueKeys.delete(key);
      this.clearCurrent(job.id);
      this.publishStatus();
      return;
    }
    const notes = resolveDevNotes(job);
    const runDocsPhase =
      Boolean(job.requireDocsFirst) && !opts?.forceCodePhase;

    // Context-quality gate BEFORE Cursor / git / processing label
    let chatRows: Awaited<ReturnType<typeof listChatMessages>> = [];
    let chatContext = "";
    try {
      chatRows = await listChatMessages({ jobId: job.id, limit: 60 });
      chatContext = formatChatContextForRun(chatRows);
    } catch (err) {
      logger.warn("Could not load chat for Run", { err: String(err) });
    }

    const quality = resolveContextQualityForCoding(job, {
      devNotes: notes || undefined,
      chatHuman: chatRows
        .filter((m) => m.role === "user" && m.body?.trim())
        .map((m) => m.body),
    });

    if (!quality.cached) {
      job.contextQuality = toContextQualityMark(quality);
      await saveJob(job);
    }

    logger.info("Context quality assessed", {
      jobId: job.id,
      level: quality.level,
      cached: Boolean(quality.cached),
      wordCount: quality.signals.wordCount,
      good: quality.signals.good.length,
      searchable: quality.signals.searchable.length,
    });

    if (quality.level === "bad") {
      logger.warn("executeJob abort — bad context", {
        jobId: job.id,
        iid: job.issue.issueIid,
        reason: quality.reason?.slice(0, 200),
        wordCount: quality.signals.wordCount,
      });
      const msg = formatBadContextChatMessage(quality, job.issue.issueIid);
      // draft (not awaiting_clarification) so job is not isJobBusy — user adds context then Run again
      job.status = "draft";
      job.lastQuestion = msg;
      job.error = "Bad Context — add more information before Run";
      job.runCount = (job.runCount ?? 0) + 1;
      job.contextQuality = toContextQualityMark(quality);
      await saveJob(job);
      await addChatMessage({
        jobId: job.id,
        issueIid: job.issue.issueIid,
        role: "agent",
        kind: "clarify",
        body: msg,
      });
      appendJobProgress(
        job.id,
        "status",
        "Bad Context — đã dừng, không gọi Cursor Agent",
      );
      try {
        const { applyIssueActions } = await import("./plugins/gitlab/client.js");
        await applyIssueActions({
          projectId: job.issue.projectId,
          issueIid: job.issue.issueIid,
          labels: ["needs_clarification"],
          labelMode: "add",
        });
      } catch (err) {
        logger.warn("Could not add needs_clarification label", {
          err: String(err),
        });
      }
      this.activeIssueKeys.delete(key);
      this.clearCurrent(job.id);
      this.publishStatus();
      return;
    }

    // Google Sheets gate — pause for OAuth when task links sheets without tokens
    let googleSheetsBlock = "";
    try {
      const { prepareGoogleSheetsForJob } = await import(
        "./modules/google/index.js"
      );
      const sheetsPrep = await prepareGoogleSheetsForJob(
        job,
        chatRows.map((m) => m.body || ""),
      );
      if (sheetsPrep.gate) {
        logger.info("executeJob pause — awaiting Google Sheets auth", {
          jobId: job.id,
        });
        appendJobProgress(
          job.id,
          "status",
          "Awaiting Google authorization for Sheets",
        );
        this.activeIssueKeys.delete(key);
        this.clearCurrent(job.id);
        this.publishStatus();
        return;
      }
      googleSheetsBlock = sheetsPrep.promptBlock || "";
    } catch (err) {
      logger.warn("Google Sheets prep failed — continuing without sheets", {
        jobId: job.id,
        err: String(err),
      });
    }

    job.status = "running";
    job.runCount = (job.runCount ?? 0) + 1;
    await saveJob(job);

    try {
      // LEVEL 3: block if project clone / local_path missing
      if (job.workspaceProjectId) {
        const { assertProjectCloneReady } = await import(
          "./workspace/resolve.js"
        );
        const ready = await assertProjectCloneReady(job.workspaceProjectId);
        if (!ready.ok || ready.level === "bad") {
          logger.warn("executeJob abort — project clone not ready", {
            jobId: job.id,
            workspaceProjectId: job.workspaceProjectId,
            level: ready.level,
            message: ready.message,
          });
          job.status = "draft";
          job.error =
            ready.message ||
            "Bad project context — clone / local_path not ready";
          await saveJob(job);
          await addChatMessage({
            jobId: job.id,
            issueIid: job.issue.issueIid,
            role: "agent",
            kind: "qa",
            body: `⛔ Project context chưa sẵn sàng:\n${job.error}\n\nVào Settings → Project để gắn PAT và Confirm clone.`,
          });
          this.activeIssueKeys.delete(key);
          this.clearCurrent(job.id);
          this.publishStatus();
          return;
        }
      }
      const startLabels = (job.completion?.onStartLabels ?? [])
        .map((s) => s.trim())
        .filter(Boolean);
      const { markIssueProcessing } = await import(
        "./plugins/gitlab/processing-label.js"
      );
      await markIssueProcessing({
        projectId: job.issue.projectId,
        issueIid: job.issue.issueIid,
        processingLabel: job.completion?.processingLabel,
        extraStartLabels: startLabels,
      });

      const targetOverride =
        config.MR_TARGET_BRANCH ||
        (await getProjectDefaultBranch(job.issue.projectId));

      const prepared = await prepareRepoForIssue({
        issueIid: job.issue.issueIid,
        title: job.issue.title,
        targetBranchOverride: targetOverride,
        baseBranch: job.baseBranch || rt?.baseBranch,
        workBranch: job.workBranch || rt?.workBranch,
        // Missing configured work branch → create from Main / base
        createWorkBranchIfMissing: true,
        repoPath,
      });
      job.branch = prepared.branch;
      await saveJob(job);

      const headBefore = await getHeadSha(repoPath);

      if (chatContext) {
        logger.info("Injecting UI chat into Run prompt", {
          jobId: job.id,
          messages: chatRows.length,
        });
      }

      const contextQualityBlock = formatContextQualityForPrompt(quality);

      logger.info("executeJob calling Cursor agent", {
        jobId: job.id,
        phase: runDocsPhase ? "docs" : "code",
        existingAgentId: job.agentId ? `${job.agentId.slice(0, 8)}…` : null,
        branch: job.branch,
      });

      let result = await this.runAgentWithRetry(job, () =>
        runNewAgent(job.issue, undefined, {
          jobId: job.id,
          devNotes: notes || undefined,
          chatContext: chatContext || undefined,
          contextQualityBlock,
          googleSheetsBlock: googleSheetsBlock || undefined,
          existingAgentId: job.agentId,
          clarifyRoundsLeft: Math.max(
            0,
            config.MAX_CLARIFY_ROUNDS - (job.clarifyRound ?? 0),
          ),
          phase: runDocsPhase ? "docs" : "code",
          approvedDocsPaths:
            !runDocsPhase && job.docsApprovedAt
              ? job.docsPaths?.length
                ? job.docsPaths
                : job.docsPath
                  ? [job.docsPath]
                  : undefined
              : undefined,
        }),
      );
      logger.info("executeJob agent returned", {
        jobId: job.id,
        kind: result.kind,
        agentId: result.agentId ? `${result.agentId.slice(0, 8)}…` : null,
      });
      job.agentId = result.agentId;
      applyTokenUsageToJob(job, result.usage);
      await saveJob(job);

      if (result.kind === "need_clarification") {
        await this.pauseForChatClarification(job, result);
        return;
      }

      if (runDocsPhase) {
        if (result.kind !== "docs_ready" && result.kind !== "unknown") {
          // unexpected DONE during docs phase — still try to harvest docs
          logger.warn("Docs phase ended without DOCS_READY", {
            jobId: job.id,
            kind: result.kind,
          });
        }

        const body = result.summary ?? "";
        const paths = parseDocsReadyPaths(body);
        const summary = docsReadySummaryText(body) || body.slice(0, 500);
        job.docsSummary = summary || undefined;
        if (paths.length) {
          job.docsPaths = paths;
          job.docsPath = paths[0];
        }

        await this.finalizeOrDeferCommit(
          job,
          repoPath,
          headBefore,
          docsCommitMessageForIssue(job.issue),
        );

        if (result.summary) {
          await addChatMessage({
            jobId: job.id,
            issueIid: job.issue.issueIid,
            role: "agent",
            kind: "qa",
            body: formatDocsReadyChatBody(body, paths),
          });
        }

        job.status = "awaiting_docs_approval";
        job.error = undefined;
        // Clear prior approval so PM must re-approve this docs pass
        job.docsApprovedAt = undefined;
        await saveJob(job);

        logger.info("Job awaiting docs approval", {
          jobId: job.id,
          docsPaths: job.docsPaths,
          runCount: job.runCount,
        });
        return;
      }

      if (result.kind === "unknown") {
        logger.warn(
          "Agent finished without DONE marker; continuing if commits exist",
          { jobId: job.id },
        );
      }

      if (result.summary) {
        job.summary = result.summary;
      }
      {
        const chatBody = extractChatBodyFromAgentText(result.text, {
          summary: result.summary,
          question: result.question,
        });
        if (chatBody && chatBody !== "(no reply)") {
          await addChatMessage({
            jobId: job.id,
            issueIid: job.issue.issueIid,
            role: "agent",
            kind: "qa",
            body: chatBody,
          });
        }
      }

      // Verify + one self-heal round BEFORE committing (code phase only)
      await this.verifyAndSelfHeal(job, repoPath, headBefore);

      const { commitSha, hasChange } = await this.finalizeOrDeferCommit(
        job,
        repoPath,
        headBefore,
        commitMessageForIssue(job.issue),
      );

      job.status = "awaiting_handoff";
      job.completedAt = new Date().toISOString();
      job.error = undefined;
      await saveJob(job);

      if (hasChange && resolveCommitMode(job) === "manual") {
        logger.info("Manual commit mode — pending local changes", {
          jobId: job.id,
          headBefore,
        });
      } else if (!hasChange) {
        logger.info("No code changes this run — skip commit", {
          jobId: job.id,
          headBefore,
          commitSha,
        });
      }
      // No auto GitLab comment after code Run — only when chat asks (GITLAB_COMMENT)
      // or on Create MR (summary).

      logger.info("Job awaiting handoff (no auto assign/labels)", {
        jobId: job.id,
        branch: prepared.branch,
        runCount: job.runCount,
        commitSha: job.commitSha,
        hasCodeChange: hasChange,
      });
    } catch (err) {
      const message = isStartupError(err)
        ? `Cursor SDK startup error: ${err.message}`
        : err instanceof Error
          ? err.message
          : String(err);
      job.status = "failed";
      job.error = message;
      await saveJob(job);
      const forceStopped = /Force-stopped|force stop|cancelled \(force/i.test(
        message,
      );
      await this.notifyJobChat(
        job,
        forceStopped ? `Đã Force Stop:\n${message}` : `Run lỗi:\n${message}`,
      );
      const { clearIssueProcessing } = await import(
        "./plugins/gitlab/processing-label.js"
      );
      await clearIssueProcessing({
        projectId: job.issue.projectId,
        issueIid: job.issue.issueIid,
        processingLabel: job.completion?.processingLabel,
      });
      logger.error("Job failed", { jobId: job.id, message });
    } finally {
      this.activeIssueKeys.delete(key);
      if (this.isCurrent(job.id)) {
        this.clearCurrent(job.id);
        this.publishStatus();
      }
      this.killedJobs.delete(job.id);
      const { clearJobKillRequested } = await import("./plugins/agent/run.js");
      clearJobKillRequested(job.id);
    }
  }
}


function applyTokenUsageToJob(job: JobRecord, usage: {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  lastInputTokens: number;
  contextWindow: number;
  contextPct: number;
  updatedAt: string;
} | null | undefined) {
  const snap = usage ?? getJobTokenUsage(job.id);
  if (!snap) return;
  job.tokenUsage = {
    inputTokens: snap.inputTokens,
    outputTokens: snap.outputTokens,
    totalTokens: snap.totalTokens,
    lastInputTokens: snap.lastInputTokens,
    contextWindow: snap.contextWindow,
    contextPct: snap.contextPct,
    updatedAt: snap.updatedAt,
  };
}

export const jobQueue = new JobQueue();
