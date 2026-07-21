import { getConfig } from "./config.js";
import {
  commitAllTracked,
  hasUncommittedChanges,
  prepareRepoForIssue,
  scrubExcludedPathsFromLastCommit,
} from "./git/prep.js";
import {
  applyIssueActions,
  commentOnIssue,
  getProjectDefaultBranch,
} from "./gitlab/client.js";
import { saveJob } from "./job-store.js";
import { logger } from "./logger.js";
import {
  cancelActiveAgentRun,
  isStartupError,
  resumeAgent,
  runNewAgent,
} from "./agent/run.js";
import {
  cancelUiClarification,
  waitForUiClarification,
} from "./clarify/ui-wait.js";
import { cancelDiffApproval } from "./review/diff-wait.js";
import { addChatMessage } from "./db/mongo.js";
import { commitMessageForIssue } from "./agent/prompt.js";
import type { IssueJob, JobRecord } from "./types.js";
import { randomUUID } from "node:crypto";

type QueueItem = { job: JobRecord; source?: string };

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

  enqueue(
    issue: IssueJob,
    opts?: {
      source?: string;
      completion?: import("./types.js").CompletionActions;
    },
  ): { enqueued: boolean; reason?: string; jobId?: string } {
    const key = `${issue.projectId}:${issue.issueIid}`;
    if (this.activeIssueKeys.has(key)) {
      return { enqueued: false, reason: "Issue already queued or running" };
    }

    const now = new Date().toISOString();
    const job: JobRecord = {
      id: randomUUID(),
      status: "queued",
      issue,
      clarifyRound: 0,
      completion: opts?.completion,
      createdAt: now,
      updatedAt: now,
    };

    this.activeIssueKeys.add(key);
    if (opts?.source) this.sources.set(job.id, opts.source);
    this.queue.push({ job, source: opts?.source });
    void saveJob(job, { source: opts?.source });
    logger.info("Enqueued job", { jobId: job.id, key, source: opts?.source });
    void this.pump();
    return { enqueued: true, jobId: job.id };
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
        job.status === "queued" ||
        job.status === "running" ||
        job.status === "awaiting_clarification" ||
        job.status === "awaiting_diff_approval"
      ) {
        job.status = "failed";
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
        await this.runJob(item.job);
      }
    } finally {
      this.running = false;
    }
  }

  private async runJob(job: JobRecord) {
    const config = getConfig();
    const key = `${job.issue.projectId}:${job.issue.issueIid}`;
    this.currentJobId = job.id;
    job.status = "running";
    await saveJob(job);

    const repoPath = config.AIHR_REPO_PATH;

    try {
      const startLabels = (job.completion?.onStartLabels ?? [])
        .map((s) => s.trim())
        .filter(Boolean);
      if (startLabels.length > 0) {
        try {
          await applyIssueActions({
            projectId: job.issue.projectId,
            issueIid: job.issue.issueIid,
            labels: startLabels,
            labelMode: "add",
          });
        } catch (err) {
          logger.warn("On-start labels failed", { err: String(err) });
        }
      }


      const targetOverride =
        config.MR_TARGET_BRANCH ||
        (await getProjectDefaultBranch(job.issue.projectId));

      const prepared = await prepareRepoForIssue({
        issueIid: job.issue.issueIid,
        title: job.issue.title,
        targetBranchOverride: targetOverride,
      });
      job.branch = prepared.branch;
      await saveJob(job);

      let result = await runNewAgent(job.issue, undefined, { jobId: job.id });
      job.agentId = result.agentId;
      await saveJob(job);

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
        await saveJob(job);
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

      // Done = local commit only (no push / MR / diff-approval gate)
      let didCommit = false;
      if (await hasUncommittedChanges(repoPath)) {
        didCommit = await commitAllTracked(
          repoPath,
          commitMessageForIssue(job.issue),
        );
        if (!didCommit) {
          logger.info(
            "No non-WIP changes to commit — treating agent DONE as already committed",
            { jobId: job.id },
          );
        }
      } else {
        logger.info("Working tree clean (excl. WIP) — already committed", {
          jobId: job.id,
        });
      }
      await scrubExcludedPathsFromLastCommit(repoPath);
      this.assertNotKilled(job);

      const dirty = await hasUncommittedChanges(repoPath);
      if (dirty) {
        // Agent already signaled DONE — leftover non-WIP dirt should not fail the job
        logger.warn(
          "Non-WIP uncommitted changes remain after DONE; continuing as succeeded",
          { jobId: job.id },
        );
      }

      job.status = "awaiting_handoff";
      job.completedAt = new Date().toISOString();
      job.error = undefined;
      await saveJob(job);

      const defaultComment = [
        "Task work 100% by AI",
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

      logger.info("Job awaiting handoff (no auto assign/labels)", {
        jobId: job.id,
        branch: prepared.branch,
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
      logger.error("Job failed", { jobId: job.id, message });
    } finally {
      this.activeIssueKeys.delete(key);
      if (this.currentJobId === job.id) this.currentJobId = null;
      this.killedJobs.delete(job.id);
    }
  }
}

export const jobQueue = new JobQueue();
