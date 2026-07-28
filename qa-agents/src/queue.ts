import { logger } from "../../src/logger.js";
import { withWorkspaceContext } from "../../src/workspace/context.js";
import { isJobBusy, type JobRecord } from "../../src/types.js";
import {
  appendQaProgress,
  listQaJobs,
  loadQaJob,
  saveQaJob,
  saveScreenshotFile,
} from "./job-store.js";
import { getQaProjectConfig } from "./store.js";
import { resolveQaPresetCredentials } from "./store.js";
import { loginBypass } from "./plugins/login/bypass.js";
import { runQaAgent, cancelQaAgentRun } from "./plugins/agent/runner.js";
import { buildQaRunPrompt } from "./plugins/agent/prompt.js";
import {
  buildQaIssueMarkdown,
  mergeCaptureIntoQa,
} from "./plugins/issue/markdown.js";
import { publishQaRealtime } from "./realtime/hub.js";

type QueueItem = {
  jobId: string;
  adjustNote?: string;
};

/**
 * QA-only job queue — parallel across projects, serial within a project lane.
 * Never imports Flow coding JobQueue.
 */
class QaJobQueue {
  private queue: QueueItem[] = [];
  private runningLanes = new Set<string>();
  private currentByLane = new Map<string, string>();
  private killed = new Set<string>();
  /** projectId → running session count */
  private sessionCounts = new Map<string, number>();

  snapshot() {
    return {
      queued: this.queue.length,
      running: this.runningLanes.size > 0,
      currentJobId: [...this.currentByLane.values()][0] ?? null,
      currentJobIds: [...this.currentByLane.values()],
    };
  }

  private publishStatus() {
    const snap = this.snapshot();
    publishQaRealtime({
      type: "status",
      currentJobId: snap.currentJobId,
      currentJobIds: snap.currentJobIds,
      queueLength: snap.queued,
      running: snap.running,
    });
  }

  enqueue(jobId: string, adjustNote?: string): void {
    if (this.killed.has(jobId)) this.killed.delete(jobId);
    if (this.queue.some((q) => q.jobId === jobId && !q.adjustNote && !adjustNote)) {
      return;
    }
    this.queue.push({ jobId, adjustNote });
    this.publishStatus();
    void this.pump();
  }

  kill(jobId: string): boolean {
    this.killed.add(jobId);
    const before = this.queue.length;
    this.queue = this.queue.filter((q) => q.jobId !== jobId);
    cancelQaAgentRun(jobId);
    void (async () => {
      const job = await loadQaJob(jobId);
      if (job && isJobBusy(job.status)) {
        job.status = "failed";
        job.error = "Killed by user";
        await saveQaJob(job);
      }
    })();
    this.publishStatus();
    return before !== this.queue.length || true;
  }

  async restoreQueuedJobs(): Promise<number> {
    const jobs = await listQaJobs({ limit: 200 });
    let n = 0;
    for (const job of jobs) {
      if (job.status === "queued") {
        this.enqueue(job.id);
        n += 1;
      } else if (job.status === "running") {
        job.status = "failed";
        job.error =
          job.error ??
          "Interrupted by QA service restart. Re-run the job to retry.";
        await saveQaJob(job);
      }
    }
    return n;
  }

  private laneKey(job: JobRecord): string {
    return job.workspaceProjectId || "default";
  }

  private async pump(): Promise<void> {
    const lanes = new Set<string>();
    for (const item of [...this.queue]) {
      const job = await loadQaJob(item.jobId);
      if (!job) continue;
      lanes.add(this.laneKey(job));
    }
    for (const lane of lanes) {
      if (!this.runningLanes.has(lane)) {
        void this.pumpLane(lane);
      }
    }
  }

  private async pumpLane(lane: string): Promise<void> {
    if (this.runningLanes.has(lane)) return;
    this.runningLanes.add(lane);
    try {
      while (true) {
        let idx = -1;
        let item: QueueItem | undefined;
        for (let i = 0; i < this.queue.length; i++) {
          const candidate = this.queue[i];
          const job = await loadQaJob(candidate.jobId);
          if (!job) {
            this.queue.splice(i, 1);
            i -= 1;
            continue;
          }
          if (this.laneKey(job) !== lane) continue;
          idx = i;
          item = candidate;
          break;
        }
        if (idx < 0 || !item) break;
        this.queue.splice(idx, 1);
        if (this.killed.has(item.jobId)) continue;

        const job = await loadQaJob(item.jobId);
        if (!job) continue;

        const cfg = await getQaProjectConfig(job.workspaceProjectId || "");
        const maxSessions = cfg?.maxConcurrentSessions ?? 1;
        const running = this.sessionCounts.get(lane) || 0;
        if (running >= maxSessions) {
          this.queue.unshift(item);
          break;
        }

        this.sessionCounts.set(lane, running + 1);
        this.currentByLane.set(lane, job.id);
        this.publishStatus();
        try {
          await this.executeJob(job, item.adjustNote);
        } catch (err) {
          logger.error("QA job failed", {
            jobId: job.id,
            err: String(err),
          });
          const fresh = await loadQaJob(job.id);
          if (fresh && fresh.status === "running") {
            fresh.status = "failed";
            fresh.error = err instanceof Error ? err.message : String(err);
            await saveQaJob(fresh);
          }
        } finally {
          this.sessionCounts.set(
            lane,
            Math.max(0, (this.sessionCounts.get(lane) || 1) - 1),
          );
          this.currentByLane.delete(lane);
          this.publishStatus();
        }
      }
    } finally {
      this.runningLanes.delete(lane);
      this.publishStatus();
      // More work may have arrived for this lane
      if (this.queue.length) void this.pump();
    }
  }

  private async executeJob(job: JobRecord, adjustNote?: string): Promise<void> {
    const username = job.ownerUsername;
    const projectId = job.workspaceProjectId;
    if (!username || !projectId) {
      throw new Error("QA job missing ownerUsername / workspaceProjectId");
    }

    await withWorkspaceContext(username, projectId, async () => {
      job.status = "running";
      job.error = undefined;
      job.runCount = (job.runCount || 0) + 1;
      await saveQaJob(job);
      appendQaProgress(job.id, "status", "QA job running");

      const config = await getQaProjectConfig(projectId);
      if (!config?.stagingBaseUrl) {
        throw new Error("QA project config missing stagingBaseUrl — set it in Config");
      }
      if (!job.qa) throw new Error("QA job missing qa payload");

      const creds = await resolveQaPresetCredentials(
        job.qa.presetId,
        projectId,
      );
      if (!creds) throw new Error("Account preset not found");

      appendQaProgress(job.id, "login", "API login bypass…");
      const { token, durationMs } = await loginBypass(config, {
        username: creds.username,
        password: creds.password,
      });
      appendQaProgress(
        job.id,
        "login",
        `Login OK in ${durationMs}ms (token redacted)`,
      );

      job.qa.presetRole = creds.role;
      if (adjustNote?.trim()) {
        job.qa.adjustNotes = [
          ...(job.qa.adjustNotes || []),
          adjustNote.trim(),
        ];
      }
      await saveQaJob(job);

      const prompt = buildQaRunPrompt({
        config,
        qa: job.qa,
        token,
        adjustNote,
      });

      const { outcome, agentId } = await runQaAgent({
        jobId: job.id,
        prompt,
        agentId: job.agentId,
      });

      if (this.killed.has(job.id)) {
        job.status = "failed";
        job.error = "Killed by user";
        await saveQaJob(job);
        return;
      }

      if (agentId) job.agentId = agentId;

      job.qa = mergeCaptureIntoQa(job.qa, {
        actionLog: outcome.actionLog,
        consoleErrors: outcome.consoleErrors,
        networkFailures: outcome.networkFailures,
        draftMarkdown: outcome.draftMarkdown,
        draftTitle: outcome.draftTitle,
        summary: outcome.summary,
      });

      if (outcome.screenshotBase64?.trim()) {
        try {
          const buf = Buffer.from(outcome.screenshotBase64.trim(), "base64");
          const name = `shot-${Date.now()}.png`;
          const rel = await saveScreenshotFile(job.id, name, buf);
          job.qa.screenshotPaths = [...(job.qa.screenshotPaths || []), rel];
          publishQaRealtime({
            type: "screenshot",
            jobId: job.id,
            path: rel,
            url: `/api/qa/artifacts/${job.id}/${rel}`,
          });
          appendQaProgress(job.id, "screenshot", `Saved ${rel}`);
        } catch (err) {
          appendQaProgress(
            job.id,
            "screenshot",
            `Failed to save: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      if (!job.qa.draftMarkdown) {
        job.qa.draftMarkdown = buildQaIssueMarkdown({
          qa: job.qa,
          functionalSummary: outcome.summary || job.qa.testcase,
        });
      }
      if (outcome.summary) job.summary = outcome.summary;

      if (outcome.kind === "need_help") {
        job.status = "needs_human_intervention";
        job.lastQuestion = outcome.helpMessage;
        job.error = undefined;
        await saveQaJob(job);
        appendQaProgress(
          job.id,
          "status",
          `Needs human intervention: ${outcome.helpMessage || ""}`,
        );
        return;
      }

      // done or unknown → still go to review so human can approve
      job.status = "awaiting_qa_review";
      job.completedAt = new Date().toISOString();
      await saveQaJob(job);
      appendQaProgress(job.id, "status", "Awaiting QA review");
    });
  }
}

export const qaJobQueue = new QaJobQueue();
