import { getConfig } from "./config.js";
import {
  commitAllTracked,
  getHeadSha,
  hasUncommittedChanges,
  prepareRepoForIssue,
} from "./git/prep.js";
import {
  commentOnIssue,
  getProjectDefaultBranch,
} from "./gitlab/client.js";
import { ensureJob, loadJob, saveJob } from "./job-store.js";
import { logger } from "./logger.js";
import {
  cancelActiveAgentRun,
  continueAgentWindow,
  hasActiveAgentRun,
  isStartupError,
  resumeAgent,
  runNewAgent,
} from "./agent/run.js";
import { getJobTokenUsage } from "./agent/progress.js";
import {
  cancelUiClarification,
  waitForUiClarification,
} from "./clarify/ui-wait.js";
import { cancelDiffApproval } from "./review/diff-wait.js";
import { addChatMessage, listChatMessages } from "./db/mongo.js";
import {
  commitMessageForIssue,
  docsCommitMessageForIssue,
  formatChatContextForRun,
} from "./agent/prompt.js";
import {
  docsReadySummaryText,
  parseDocsReadyPaths,
} from "./docs/analysis.js";
import type { CompletionActions, IssueJob, JobRecord } from "./types.js";
import { isJobBusy, resolveDevNotes } from "./types.js";
import { getRuntimeContext } from "./workspace/runtime.js";
import { withWorkspaceContext } from "./workspace/routes.js";

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

  /**
   * One issue → one job. Re-run reuses the same document (chat/notes/context).
   */
  async enqueue(
    issue: IssueJob,
    opts?: {
      source?: string;
      completion?: CompletionActions;
      devNotes?: string;
      /** @deprecated use devNotes */
      techLeadNotes?: string;
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

    const notes =
      opts?.devNotes?.trim() ||
      opts?.techLeadNotes?.trim() ||
      undefined;

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

    if (job.status === "awaiting_clarification") {
      throw new Error("Đang chờ clarify — trả lời ở ô Clarify");
    }

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
      if (this.currentJobId === jobId) this.currentJobId = null;
    }

    if (hasActiveAgentRun(jobId) || isJobBusy(job.status)) {
      throw new Error(
        "Agent đang chạy trên job này — đợi xong hoặc bấm Force Stop rồi Gửi lại",
      );
    }

    const prevStatus = job.status;
    const wasDone =
      prevStatus === "awaiting_handoff" || prevStatus === "succeeded";
    const key = `${job.issue.projectId}:${job.issue.issueIid}`;
    this.activeIssueKeys.add(key);
    this.currentJobId = job.id;
    job.status = "running";
    job.error = undefined;
    await saveJob(job);

    const runFollowUp = async (): Promise<{
      ok: boolean;
      job: JobRecord;
      kind: string;
      summary?: string;
      question?: string;
      resumed?: boolean;
      hasChange?: boolean;
    }> => {
      const config = getConfig();
      const rt = getRuntimeContext();
      const repoPath = rt?.repoPath ?? config.AIHR_REPO_PATH;
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

      const priorChat = await listChatMessages({ jobId: job.id, limit: 40 });
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

      await addChatMessage({
        jobId: job.id,
        issueIid: job.issue.issueIid,
        role: "user",
        kind: "qa",
        body: msg,
      });

      const headBefore = await getHeadSha(repoPath);
      let result = await continueAgentWindow(job.issue, msg, {
        jobId: job.id,
        chatHistory: chatHistory || undefined,
      });
      job.agentId = result.agentId;
      applyTokenUsageToJob(job, result.usage);
      await saveJob(job);

      result = await this.runClarifyLoop(job, result);

      await addChatMessage({
        jobId: job.id,
        issueIid: job.issue.issueIid,
        role: "agent",
        kind: "qa",
        body:
          result.summary?.trim() ||
          result.text.trim().slice(0, 8000) ||
          "(no reply)",
      });

      if (result.kind === "need_clarification") {
        const refreshed = await loadJob(job.id);
        if (refreshed) job = refreshed;
        return {
          ok: true,
          job,
          kind: result.kind,
          question: result.question,
          summary: result.summary,
          resumed: result.resumed,
        };
      }

      const { hasChange } = await this.finalizeLocalCommit(
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
      // Done tasks: never demote to failed on follow-up errors
      if (wasDone) {
        job.status = prevStatus;
        job.agentId = undefined;
      } else {
        const { isTransientCursorTransportError } = await import(
          "./agent/run.js"
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
      throw err instanceof Error ? err : new Error(message);
    } finally {
      this.activeIssueKeys.delete(key);
      if (this.currentJobId === job.id) this.currentJobId = null;
      this.killedJobs.delete(job.id);
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

    const queuedIdx = this.queue.findIndex((q) => q.job.id === jobId);
    if (queuedIdx >= 0) {
      const [item] = this.queue.splice(queuedIdx, 1);
      const key = `${item.job.issue.projectId}:${item.job.issue.issueIid}`;
      item.job.status = "failed";
      item.job.error = reason;
      await saveJob(item.job);
      this.activeIssueKeys.delete(key);
      this.killedJobs.delete(jobId);
      logger.warn("Killed queued job", { jobId, reason });
      return { ok: true, phase: "queued" };
    }

    cancelUiClarification(jobId, reason);
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
    return { ok: false, phase: "not_found_or_terminal" };
  }

  private assertNotKilled(job: JobRecord) {
    if (this.killedJobs.has(job.id)) {
      throw new Error(job.error || "Force-stopped from UI");
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

  private async runClarifyLoop(
    job: JobRecord,
    initial: Awaited<ReturnType<typeof runNewAgent>>,
  ): Promise<Awaited<ReturnType<typeof runNewAgent>>> {
    const config = getConfig();
    let result = initial;
    while (result.kind === "need_clarification") {
      job.clarifyRound += 1;
      if (job.clarifyRound > config.MAX_CLARIFY_ROUNDS) {
        throw new Error(
          `Exceeded MAX_CLARIFY_ROUNDS (${config.MAX_CLARIFY_ROUNDS})`,
        );
      }
      const question = result.question ?? "(no question text)";
      job.status = "awaiting_clarification";
      job.lastQuestion = question;
      await saveJob(job);

      await addChatMessage({
        jobId: job.id,
        issueIid: job.issue.issueIid,
        role: "agent",
        kind: "clarify",
        body: question,
      });

      const answer = await waitForUiClarification({
        jobId: job.id,
        question,
      });

      await addChatMessage({
        jobId: job.id,
        issueIid: job.issue.issueIid,
        role: "user",
        kind: "clarify",
        body: answer,
      });

      job.status = "running";
      await saveJob(job);
      result = await resumeAgent(result.agentId, answer, job.issue, {
        jobId: job.id,
      });
      job.agentId = result.agentId;
      applyTokenUsageToJob(job, result.usage);
      await saveJob(job);
    }
    return result;
  }

  private async finalizeLocalCommit(
    job: JobRecord,
    repoPath: string,
    headBefore: string | null,
    commitMsg: string,
  ): Promise<{ commitSha: string | null; hasChange: boolean }> {
    let madeCommit = false;
    let commitSha: string | null = null;
    if (await hasUncommittedChanges(repoPath)) {
      commitSha = await commitAllTracked(repoPath, commitMsg);
      if (commitSha) {
        madeCommit = true;
      } else {
        logger.info(
          "Nothing to commit — treating agent output as already committed",
          { jobId: job.id },
        );
      }
    } else {
      logger.info("Working tree clean — already committed", {
        jobId: job.id,
      });
    }
    commitSha = (await getHeadSha(repoPath)) ?? commitSha;
    this.assertNotKilled(job);

    const dirty = await hasUncommittedChanges(repoPath);
    if (dirty) {
      logger.warn(
        "Uncommitted changes remain after agent finish; continuing",
        { jobId: job.id },
      );
    }

    const hasChange =
      madeCommit ||
      Boolean(headBefore && commitSha && headBefore !== commitSha);

    if (hasChange && commitSha) {
      job.commitSha = commitSha;
      const prev = Array.isArray(job.commitShas) ? job.commitShas : [];
      if (!prev.includes(commitSha)) {
        job.commitShas = [...prev, commitSha].slice(-20);
      } else {
        job.commitShas = prev;
      }
    }

    return { commitSha, hasChange };
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
    job.status = "running";
    job.runCount = (job.runCount ?? 0) + 1;
    await saveJob(job);

    const rt = getRuntimeContext();
    const repoPath = rt?.repoPath ?? config.AIHR_REPO_PATH;
    if (!repoPath) {
      job.status = "failed";
      job.error = "No repo path in workspace context";
      await saveJob(job);
      this.activeIssueKeys.delete(key);
      this.currentJobId = null;
      return;
    }
    const notes = resolveDevNotes(job);
    const runDocsPhase =
      Boolean(job.requireDocsFirst) && !opts?.forceCodePhase;

    try {
      const startLabels = (job.completion?.onStartLabels ?? [])
        .map((s) => s.trim())
        .filter(Boolean);
      const { markIssueProcessing } = await import(
        "./gitlab/processing-label.js"
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

      let chatContext = "";
      try {
        const chat = await listChatMessages({ jobId: job.id, limit: 60 });
        chatContext = formatChatContextForRun(chat);
        if (chatContext) {
          logger.info("Injecting UI chat into Run prompt", {
            jobId: job.id,
            messages: chat.length,
          });
        }
      } catch (err) {
        logger.warn("Could not load chat for Run", { err: String(err) });
      }

      let result = await runNewAgent(job.issue, undefined, {
        jobId: job.id,
        techLeadNotes: notes || undefined,
        devNotes: notes || undefined,
        chatContext: chatContext || undefined,
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

      result = await this.runClarifyLoop(job, result);
      applyTokenUsageToJob(job, result.usage);
      await saveJob(job);

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

        await this.finalizeLocalCommit(
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

      const { commitSha, hasChange } = await this.finalizeLocalCommit(
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
        const defaultComment = [
          "AI-Generated",
          result.summary?.trim() || null,
        ]
          .filter(Boolean)
          .join("\n\n");
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
      const { clearIssueProcessing } = await import(
        "./gitlab/processing-label.js"
      );
      await clearIssueProcessing({
        projectId: job.issue.projectId,
        issueIid: job.issue.issueIid,
        processingLabel: job.completion?.processingLabel,
      });
      logger.error("Job failed", { jobId: job.id, message });
    } finally {
      this.activeIssueKeys.delete(key);
      if (this.currentJobId === job.id) this.currentJobId = null;
      this.killedJobs.delete(job.id);
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
