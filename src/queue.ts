import { getConfig } from "./config.js";
import {
  hasUncommittedChanges,
  prepareRepoForIssue,
  pushBranch,
  scrubExcludedPathsFromLastCommit,
} from "./git/prep.js";
import {
  commentOnIssue,
  createMergeRequest,
  getProjectDefaultBranch,
} from "./gitlab/client.js";
import { saveJob } from "./job-store.js";
import { logger } from "./logger.js";
import { isStartupError, resumeAgent, runNewAgent } from "./agent/run.js";
import { askAndWaitForReply } from "./teams/clarify.js";
import type { IssueJob, JobRecord } from "./types.js";
import { randomUUID } from "node:crypto";

type QueueItem = { job: JobRecord };

export class JobQueue {
  private queue: QueueItem[] = [];
  private running = false;
  private activeIssueKeys = new Set<string>();

  enqueue(issue: IssueJob): { enqueued: boolean; reason?: string; jobId?: string } {
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
      createdAt: now,
      updatedAt: now,
    };

    this.activeIssueKeys.add(key);
    this.queue.push({ job });
    void saveJob(job);
    logger.info("Enqueued job", { jobId: job.id, key });
    void this.pump();
    return { enqueued: true, jobId: job.id };
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
    job.status = "running";
    await saveJob(job);

    const repoPath = config.AIHR_REPO_PATH;

    try {
      await commentOnIssue(
        job.issue.projectId,
        job.issue.issueIid,
        `🤖 **flow_auto_work** started on this issue (job \`${job.id}\`).`,
      );

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

      await commentOnIssue(
        job.issue.projectId,
        job.issue.issueIid,
        `🌿 Working on current branch \`${prepared.branch}\` (no branch switch).`,
      );

      let result = await runNewAgent(job.issue);
      job.agentId = result.agentId;
      await saveJob(job);

      while (result.kind === "need_clarification") {
        job.clarifyRound += 1;
        if (job.clarifyRound > config.MAX_CLARIFY_ROUNDS) {
          throw new Error(
            `Exceeded MAX_CLARIFY_ROUNDS (${config.MAX_CLARIFY_ROUNDS})`,
          );
        }
        job.status = "awaiting_clarification";
        job.lastQuestion = result.question;
        await saveJob(job);

        await commentOnIssue(
          job.issue.projectId,
          job.issue.issueIid,
          `❓ Need clarification (Teams):\n\n${result.question}`,
        );

        const answer = await askAndWaitForReply({
          issue: job.issue,
          question: result.question ?? "(no question text)",
        });

        job.status = "running";
        await saveJob(job);
        result = await resumeAgent(result.agentId, answer, job.issue);
        job.agentId = result.agentId;
        await saveJob(job);
      }

      if (result.kind === "unknown") {
        logger.warn(
          "Agent finished without DONE marker; continuing if commits exist",
          { jobId: job.id },
        );
      }

      await scrubExcludedPathsFromLastCommit(repoPath);

      const dirty = await hasUncommittedChanges(repoPath);
      if (dirty) {
        throw new Error(
          "Agent left uncommitted changes (excluding WIP exclude-paths). Expected a commit before DONE.",
        );
      }

      await pushBranch(repoPath, prepared.branch);

      const mrTitle = `${job.issue.title} (#${job.issue.issueIid})`;
      const mrDescription = [
        `Closes #${job.issue.issueIid}`,
        "",
        "## Summary",
        result.summary || result.text.slice(-1500) || "(no summary)",
        "",
        "_Opened by flow_auto_work — please review before merge._",
      ].join("\n");

      const mr = await createMergeRequest({
        projectId: job.issue.projectId,
        sourceBranch: prepared.branch,
        targetBranch: prepared.defaultBranch,
        title: mrTitle,
        description: mrDescription,
        issueIid: job.issue.issueIid,
      });

      job.mrUrl = mr.webUrl;
      job.status = "succeeded";
      await saveJob(job);

      await commentOnIssue(
        job.issue.projectId,
        job.issue.issueIid,
        `✅ Auto-work finished.\n\n- Branch: \`${prepared.branch}\`\n- MR: ${mr.webUrl}\n\n${result.summary ?? ""}`.trim(),
      );

      logger.info("Job succeeded", { jobId: job.id, mrUrl: mr.webUrl });
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
      try {
        await commentOnIssue(
          job.issue.projectId,
          job.issue.issueIid,
          `❌ Auto-work failed:\n\n\`\`\`\n${message}\n\`\`\``,
        );
      } catch (commentErr) {
        logger.warn("Failed to comment failure", { err: String(commentErr) });
      }
    } finally {
      this.activeIssueKeys.delete(key);
    }
  }
}

export const jobQueue = new JobQueue();
