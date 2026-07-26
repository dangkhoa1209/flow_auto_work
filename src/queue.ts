import { getConfig } from "./config.js";
import {
  collectCommitActions,
  softResetTo,
  syncLocalToRemoteCommit,
} from "./plugins/git/changes-for-api.js";
import {
  currentBranch,
  detectDefaultBranch,
  getHeadSha,
  hasUncommittedChanges,
  prepareRepoForIssue,
} from "./plugins/git/prep.js";
import {
  commentOnIssue,
  getProjectDefaultBranch,
} from "./plugins/gitlab/client.js";
import {
  createRepositoryCommit,
  gitlabBranchExists,
} from "./plugins/gitlab/commits.js";
import {
  postAgentGitlabComments,
  stripGitlabCommentBlocks,
  withAiGeneratedMarker,
} from "./plugins/gitlab/agent-comment.js";
import { ensureJob, loadJob, saveJob } from "./job-store.js";
import { logger } from "./logger.js";
import {
  cancelActiveAgentRun,
  continueAgentWindow,
  hasActiveAgentRun,
  isStartupError,
  runNewAgent,
} from "./plugins/agent/run.js";
import { appendJobProgress, getJobTokenUsage } from "./plugins/agent/progress.js";
import { cancelDiffApproval } from "./plugins/review/diff-wait.js";
import { addChatMessage, listChatMessages } from "./db/mongo.js";
import { publishRealtime } from "./plugins/realtime/hub.js";
import {
  commitMessageForIssue,
  docsCommitMessageForIssue,
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
  parseDocsReadyPaths,
} from "./plugins/docs/analysis.js";
import type { CompletionActions, IssueJob, JobRecord } from "./types.js";
import { isJobBusy, resolveDevNotes } from "./types.js";
import { getRuntimeContext } from "./workspace/runtime.js";
import { withWorkspaceContext } from "./workspace/context.js";

type QueueItem = {
  job: JobRecord;
  source?: string;
  /** After PM approves docs — force code phase even if requireDocsFirst */
  forceCodePhase?: boolean;
};

export class JobQueue {
  private queue: QueueItem[] = [];
  private running = false;
  private activeIssueKeys = new Set<string>();
  private sources = new Map<string, string>();
  /** Currently executing job (not merely queued). */
  private currentJobId: string | null = null;
  /** Jobs force-stopped — runJob should abort ASAP. */
  private killedJobs = new Set<string>();

  snapshot() {
    return {
      running: this.running,
      queued: this.queue.length,
      currentJobId: this.currentJobId,
      activeIssues: [...this.activeIssueKeys],
    };
  }

  /** Push queue status to SSE subscribers. */
  publishStatus(reason?: string) {
    const snap = this.snapshot();
    publishRealtime({
      type: "status",
      currentJobId: snap.currentJobId,
      queueLength: snap.queued,
      running: snap.running,
    });
    if (reason) {
      publishRealtime({ type: "jobs", reason });
    }
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
    const key = `${issue.projectId}:${issue.issueIid}`;
    if (this.activeIssueKeys.has(key)) {
      return { enqueued: false, reason: "Issue already queued or running" };
    }
    if (this.queue.some((q) => `${q.job.issue.projectId}:${q.job.issue.issueIid}` === key)) {
      return { enqueued: false, reason: "Issue already queued or running" };
    }

    const notes = opts?.devNotes?.trim() || undefined;

    const job = await ensureJob(issue, {
      source: opts?.source,
      completion: opts?.completion,
      devNotes: notes,
      requireDocsFirst: opts?.requireDocsFirst,
    });

    if (notes !== undefined) {
      job.devNotes = notes || undefined;
    }
    if (opts?.completion) job.completion = opts.completion;
    if (opts?.requireDocsFirst !== undefined) {
      job.requireDocsFirst = opts.requireDocsFirst;
    }

    if (isJobBusy(job.status) && job.id !== this.currentJobId) {
      const fresh = await loadJob(job.id);
      if (fresh && isJobBusy(fresh.status)) {
        return { enqueued: false, reason: "Issue already queued or running" };
      }
    }

    job.issue = issue;
    job.status = "queued";
    job.error = undefined;
    job.clarifyRound = 0;
    job.lastQuestion = undefined;
    job.handedOffAt = undefined;

    const rt = getRuntimeContext();
    if (rt) {
      job.ownerUsername = rt.gitlabUsername;
      job.workspaceProjectId = rt.projectId;
      job.flowTaskId = job.id;
      job.baseBranch = rt.baseBranch;
      job.workBranch = rt.workBranch;
    }

    this.activeIssueKeys.add(key);
    if (opts?.source) this.sources.set(job.id, opts.source);
    this.queue.push({
      job,
      source: opts?.source,
      forceCodePhase: opts?.forceCodePhase,
    });
    await saveJob(job, { source: opts?.source });
    this.publishStatus("enqueue");
    logger.info("Enqueued job", {
      jobId: job.id,
      key,
      source: opts?.source,
      runCount: job.runCount,
      requireDocsFirst: job.requireDocsFirst,
      forceCodePhase: opts?.forceCodePhase,
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
   * Cursor-IDE-style follow-up on the same agent window (ask / fix / do more).
   * Keeps context; commits if code changed.
   * If the job was already done (awaiting_handoff / succeeded) and this
   * follow-up has no code change — or errors — restore the previous status
   * (do not flip to failed / re-open handoff).
   */
  async followUpChat(
    jobId: string,
    message: string,
  ): Promise<{
    ok: boolean;
    job: JobRecord;
    kind: string;
    summary?: string;
    question?: string;
    resumed?: boolean;
    hasChange?: boolean;
  }> {
    const msg = message.trim();
    if (!msg) throw new Error("message required");

    const loaded = await loadJob(jobId);
    if (!loaded) throw new Error("Job not found");
    let job: JobRecord = loaded;

    // Orphaned busy (no in-memory Cursor run) — reclaim so user can retry after hang/restart
    if (isJobBusy(job.status) && !hasActiveAgentRun(jobId)) {
      const reclaimTo =
        job.handedOffAt
          ? "succeeded"
          : job.completedAt
            ? "awaiting_handoff"
            : "draft";
      logger.warn("Reclaiming orphaned busy job before follow-up", {
        jobId,
        from: job.status,
        to: reclaimTo,
        currentJobId: this.currentJobId,
      });
      job.status = reclaimTo;
      job.error =
        job.error ||
        "Previous agent run was stuck / interrupted — reclaimed for retry";
      await saveJob(job);
      if (this.currentJobId === jobId) {
        this.currentJobId = null;
        this.publishStatus();
      }
    }

    if (hasActiveAgentRun(jobId) || isJobBusy(job.status)) {
      throw new Error(
        "Agent is running on this job — wait for it to finish or Force Stop, then send again",
      );
    }

    const prevStatus = job.status;
    const wasDone =
      prevStatus === "awaiting_handoff" || prevStatus === "succeeded";
    const key = `${job.issue.projectId}:${job.issue.issueIid}`;

    // Context gate for coding follow-up (skip assess if already marked good)
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

    // Save user message immediately — before quality/status SSE (avoid UI refresh dropping it)
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
    logger.info("Context quality for follow-up", {
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
        body: body,
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
      return {
        ok: false,
        job,
        kind: "bad_context",
        question: body,
      };
    }

    this.activeIssueKeys.add(key);
    this.currentJobId = job.id;
    this.publishStatus();
    job.status = "running";
    job.error = undefined;
    await saveJob(job);

    const contextQualityBlock = formatContextQualityForPrompt(quality);

    const runFollowUp = async (): Promise<{
      ok: boolean;
      job: JobRecord;
      kind: string;
      summary?: string;
      question?: string;
      resumed?: boolean;
      hasChange?: boolean;
    }> => {
      const rt = getRuntimeContext();
      const repoPath = rt?.repoPath?.trim();
      if (!repoPath) throw new Error("No repo path in workspace context");

      // Prefer fixed workBranch; only auto-create feat/hotfix when none configured
      const fixedWork = (job.workBranch || rt?.workBranch || "").trim();
      const prepared = await prepareRepoForIssue({
        issueIid: Math.max(job.issue.issueIid, 0),
        title: job.issue.title,
        baseBranch: job.baseBranch || rt?.baseBranch,
        // Configured work branch OR adhoc hotfix name (create only if not configured work)
        workBranch: fixedWork || (job.kind === "adhoc" ? job.branch : undefined),
        createWorkBranchIfMissing: !fixedWork,
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
      let result = await continueAgentWindow(job.issue, msg, {
        jobId: job.id,
        chatHistory: chatHistory || undefined,
        contextQualityBlock,
      });
      job.agentId = result.agentId;
      applyTokenUsageToJob(job, result.usage);
      await saveJob(job);

      // Post GITLAB_COMMENT immediately — do not wait for clarify (avoid hang + lost comment)
      await this.deliverAgentGitlabComments(job, result.text);

      const chatBody =
        stripGitlabCommentBlocks(
          result.summary?.trim() ||
            result.text.trim().slice(0, 8000) ||
            "(no reply)",
        ) ||
        result.question?.trim() ||
        "(no reply)";
      await addChatMessage({
        jobId: job.id,
        issueIid: job.issue.issueIid,
        role: "agent",
        kind: "qa",
        body: chatBody,
      });

      // Agent asked a question — park for chat reply (no blocking waiter)
      if (result.kind === "need_clarification") {
        job.status = "awaiting_clarification";
        job.lastQuestion = result.question ?? chatBody;
        job.error = undefined;
        job.clarifyRound = (job.clarifyRound ?? 0) + 1;
        await saveJob(job);
        return {
          ok: true,
          job,
          kind: result.kind,
          question: result.question,
          summary: result.summary,
          resumed: result.resumed,
        };
      }

      const { hasChange } = await this.finalizeGitlabCommit(
        job,
        repoPath,
        headBefore,
        commitMessageForIssue(job.issue),
      );

      if (result.summary) job.summary = result.summary;

      // Already-done job + no new code → keep prior status (Q&A / chat only)
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

      return {
        ok: true,
        job,
        kind: result.kind,
        summary: result.summary,
        question: result.question,
        resumed: result.resumed,
        hasChange,
      };
    };

    try {
      if (job.ownerUsername && job.workspaceProjectId) {
        return await withWorkspaceContext(
          job.ownerUsername,
          job.workspaceProjectId,
          runFollowUp,
        );
      }
      return await runFollowUp();
    } catch (err) {
      const message = isStartupError(err)
        ? `Cursor SDK startup error: ${err.message}`
        : err instanceof Error
          ? err.message
          : String(err);

      // Force Stop during chat — keep killJob status, don't flip to failed wrongly
      if (/Force-stopped|force stop|cancelled \(force/i.test(message)) {
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
        throw new Error("Force-stopped from UI");
      }

      // Done tasks: never demote to failed on follow-up errors
      if (wasDone) {
        job.status = prevStatus;
        job.agentId = undefined;
      } else {
        const { isTransientCursorTransportError } = await import(
          "./plugins/agent/run.js"
        );
        if (isTransientCursorTransportError(err)) {
          job.status = prevStatus;
          job.agentId = undefined;
        } else {
          job.status = "failed";
        }
      }
      job.error = message;
      await saveJob(job);
      await this.notifyJobChat(job, `Chat lỗi:\n${message}`);
      throw err instanceof Error ? err : new Error(message);
    } finally {
      this.activeIssueKeys.delete(key);
      if (this.currentJobId === job.id) {
        this.currentJobId = null;
        this.publishStatus();
      }
      this.killedJobs.delete(job.id);
      const { clearJobKillRequested } = await import("./plugins/agent/run.js");
      clearJobKillRequested(job.id);
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
      const key = `${item.job.issue.projectId}:${item.job.issue.issueIid}`;
      item.job.status = "failed";
      item.job.error = reason;
      item.job.agentId = undefined;
      await saveJob(item.job);
      await this.notifyJobChat(
        item.job,
        `Đã hủy job trong hàng chờ:\n${reason}`,
      );
      this.activeIssueKeys.delete(key);
      this.killedJobs.delete(jobId);
      clearJobKillRequested(jobId);
      this.publishStatus("kill-queued");
      logger.warn("Killed queued job", { jobId, reason });
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
        this.activeIssueKeys.delete(
          `${job.issue.projectId}:${job.issue.issueIid}`,
        );
      }
    }

    if (this.currentJobId === jobId) {
      logger.warn("Kill signal sent to running job", {
        jobId,
        agentCancelled,
        reason,
      });
      this.publishStatus("kill-running");
      return { ok: true, phase: "running", agentCancelled };
    }

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

  private async pump() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length > 0) {
        const item = this.queue.shift()!;
        await this.runJob(item.job, { forceCodePhase: item.forceCodePhase });
      }
    } finally {
      this.running = false;
    }
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
    job.status = "awaiting_clarification";
    job.lastQuestion = question;
    job.error = undefined;
    await saveJob(job);

    await addChatMessage({
      jobId: job.id,
      issueIid: job.issue.issueIid,
      role: "agent",
      kind: "qa",
      body: question,
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
   * Commit via GitLab Commits API (author = PAT owner), then sync local to that SHA.
   * If the agent already `git commit` locally, soft-reset to headBefore and re-commit via API.
   */
  private async finalizeGitlabCommit(
    job: JobRecord,
    repoPath: string,
    headBefore: string | null,
    commitMsg: string,
  ): Promise<{ commitSha: string | null; hasChange: boolean }> {
    const rt = getRuntimeContext();
    const headNow = await getHeadSha(repoPath);
    const dirty = await hasUncommittedChanges(repoPath);

    if (!dirty && headBefore && headNow && headBefore === headNow) {
      logger.info("No local changes to commit via GitLab API", {
        jobId: job.id,
      });
      return { commitSha: headNow, hasChange: false };
    }

    // Agent may have committed locally — soft-reset so one API commit (PAT identity)
    if (headBefore && headNow && headBefore !== headNow) {
      logger.info("Soft-reset local commits before GitLab API commit", {
        jobId: job.id,
        headBefore: headBefore.slice(0, 12),
        headNow: headNow.slice(0, 12),
      });
      await softResetTo(repoPath, headBefore);
    }

    this.assertNotKilled(job);

    const actions = await collectCommitActions(repoPath);
    if (!actions.length) {
      const sha = (await getHeadSha(repoPath)) ?? headBefore;
      logger.info("Nothing to commit via GitLab API", { jobId: job.id });
      return { commitSha: sha, hasChange: false };
    }

    const branch =
      (job.branch || job.workBranch || "").trim() ||
      (await currentBranch(repoPath));
    const projectIdOrPath =
      rt?.gitlabProjectId ??
      rt?.gitlabPath ??
      job.issue.projectId;
    if (projectIdOrPath === undefined || projectIdOrPath === "") {
      throw new Error("No GitLab project for Commits API");
    }

    const remoteExists = await gitlabBranchExists(projectIdOrPath, branch);
    let startBranch: string | undefined;
    if (!remoteExists) {
      startBranch =
        rt?.baseBranch?.trim() ||
        job.baseBranch?.trim() ||
        (await detectDefaultBranch(repoPath));
      logger.info("GitLab branch missing — creating via start_branch", {
        jobId: job.id,
        branch,
        startBranch,
      });
    }

    logger.info("Creating GitLab commit via API", {
      jobId: job.id,
      branch,
      actions: actions.length,
      remoteExists,
    });

    const created = await createRepositoryCommit({
      projectIdOrPath,
      branch,
      startBranch,
      message: commitMsg,
      actions,
      token: rt?.gitlabToken,
    });

    this.assertNotKilled(job);

    await syncLocalToRemoteCommit(repoPath, branch, created.id);

    const commitSha = created.id;
    job.commitSha = commitSha;
    const prev = Array.isArray(job.commitShas) ? job.commitShas : [];
    if (!prev.includes(commitSha)) {
      job.commitShas = [...prev, commitSha].slice(-20);
    } else {
      job.commitShas = prev;
    }

    const stillDirty = await hasUncommittedChanges(repoPath);
    if (stillDirty) {
      logger.warn("Working tree still dirty after GitLab sync", {
        jobId: job.id,
        commitSha: commitSha.slice(0, 12),
      });
    }

    return { commitSha, hasChange: true };
  }

  private async runJob(
    job: JobRecord,
    opts?: { forceCodePhase?: boolean },
  ) {
    const execute = () => this.executeJob(job, opts);
    if (job.ownerUsername && job.workspaceProjectId) {
      await withWorkspaceContext(
        job.ownerUsername,
        job.workspaceProjectId,
        execute,
      );
      return;
    }
    await execute();
  }

  private async executeJob(
    job: JobRecord,
    opts?: { forceCodePhase?: boolean },
  ) {
    const config = getConfig();
    const key = `${job.issue.projectId}:${job.issue.issueIid}`;
    this.currentJobId = job.id;
    this.publishStatus();

    const rt = getRuntimeContext();
    const repoPath = rt?.repoPath?.trim();
    if (!repoPath) {
      job.status = "failed";
      job.error = "No repo path in workspace context";
      await saveJob(job);
      await this.notifyJobChat(
        job,
        "Run dừng: chưa có repo path trong workspace.\nVào Settings → Project để gắn PAT / Confirm clone.",
      );
      this.activeIssueKeys.delete(key);
      this.currentJobId = null;
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
      this.currentJobId = null;
      this.publishStatus();
      return;
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
          this.currentJobId = null;
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
        // Workspace work branch must already exist — do not create
        createWorkBranchIfMissing: false,
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

      let result = await runNewAgent(job.issue, undefined, {
        jobId: job.id,
        devNotes: notes || undefined,
        chatContext: chatContext || undefined,
        contextQualityBlock,
        existingAgentId: job.agentId,
        phase: runDocsPhase ? "docs" : "code",
        approvedDocsPaths:
          !runDocsPhase && job.docsApprovedAt
            ? job.docsPaths?.length
              ? job.docsPaths
              : job.docsPath
                ? [job.docsPath]
                : undefined
            : undefined,
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

        await this.finalizeGitlabCommit(
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
            body: `DOCS READY:\n${summary}${
              paths.length ? `\n\nPaths:\n${paths.map((p) => `- ${p}`).join("\n")}` : ""
            }`,
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
        await addChatMessage({
          jobId: job.id,
          issueIid: job.issue.issueIid,
          role: "agent",
          kind: "qa",
          body: `DONE summary:\n${result.summary}`,
        });
      }

      const { commitSha, hasChange } = await this.finalizeGitlabCommit(
        job,
        repoPath,
        headBefore,
        commitMessageForIssue(job.issue),
      );

      job.status = "awaiting_handoff";
      job.completedAt = new Date().toISOString();
      job.error = undefined;
      await saveJob(job);

      if (hasChange) {
        const defaultComment = withAiGeneratedMarker(
          result.summary?.trim() || "(AI run completed — see commit)",
        );
        const extraComment = job.completion?.comment?.trim();
        const finalComment = [defaultComment, extraComment]
          .filter(Boolean)
          .join("\n\n");

        await commentOnIssue(
          job.issue.projectId,
          job.issue.issueIid,
          finalComment,
        );
      } else {
        logger.info("No code changes this run — skip GitLab comment", {
          jobId: job.id,
          headBefore,
          commitSha,
        });
      }

      // Explicit <<<GITLAB_COMMENT>>> from agent (comment-only or extra notes)
      try {
        const posted = await postAgentGitlabComments({
          projectId: job.issue.projectId,
          issueIid: job.issue.issueIid,
          agentText: result.text,
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
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn("Agent GITLAB_COMMENT post failed", {
          jobId: job.id,
          err: msg,
        });
        await this.notifyJobChat(
          job,
          `Đăng comment GitLab thất bại:\n${msg}`,
        );
      }

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
      if (this.currentJobId === job.id) {
        this.currentJobId = null;
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
