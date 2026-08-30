import { getConfig } from "../../config.js";
import { logger } from "../../logger.js";
import { AppError } from "../../utils/AppError.js";
import { requireWhitelistedScript } from "./catalog.js";
import { publishBuildEvent } from "./events.js";
import { cancelRunningBuild, isBuildRunning, runBuildJob } from "./runner.js";
import {
  createQueuedBuildJob,
  insertBuildJob,
  listQueuedBuildJobs,
  listRunningBuildJobs,
  markInterruptedBuildsFailed,
  requireBuildJob,
  tryClaimBuildJobForRun,
  updateBuildJob,
} from "./store.js";
import type { WhitelistedScript } from "./types.js";
import {
  isTerminalBuildStatus,
  type BuildJob,
  type BuildQueueSnapshot,
} from "./types.js";

export type TriggerBuildInput = {
  scriptId: string;
  triggeredBy: string;
  note?: string;
};

export type BuildQueueDeps = {
  run?: (jobId: string) => Promise<unknown>;
  cancelRun?: (jobId: string, reason: string) => Promise<boolean>;
  isRunning?: (jobId: string) => boolean;
  requireScript?: (
    scriptId: string,
  ) => WhitelistedScript | Promise<WhitelistedScript>;
  insert?: (job: BuildJob) => Promise<BuildJob>;
  update?: (
    id: string,
    patch: Partial<Omit<BuildJob, "id">>,
  ) => Promise<BuildJob>;
  requireJob?: (id: string) => Promise<BuildJob>;
  claimJob?: (jobId: string) => Promise<BuildJob | null>;
  listRunningJobs?: () => Promise<BuildJob[]>;
  listQueuedJobIds?: () => Promise<string[]>;
  queueMax?: number;
};

/**
 * In-process pump for a **system-wide** FIFO queue (concurrency hard-locked to 1).
 * Job order and the global "only one running" rule are enforced via MongoDB so every
 * Devops user shares the same queue — not per-user runners.
 */
export class BuildQueue {
  private readonly queuedIds: string[] = [];
  private currentBuildId: string | null = null;
  private pumping = false;
  private shuttingDown = false;
  private readonly run: (jobId: string) => Promise<unknown>;
  private readonly cancelRun: (
    jobId: string,
    reason: string,
  ) => Promise<boolean>;
  private readonly isRunning: (jobId: string) => boolean;
  private readonly requireScript: (
    scriptId: string,
  ) => WhitelistedScript | Promise<WhitelistedScript>;
  private readonly insert: (job: BuildJob) => Promise<BuildJob>;
  private readonly update: (
    id: string,
    patch: Partial<Omit<BuildJob, "id">>,
  ) => Promise<BuildJob>;
  private readonly requireJob: (id: string) => Promise<BuildJob>;
  private readonly claimJob: (jobId: string) => Promise<BuildJob | null>;
  private readonly listRunningJobs: () => Promise<BuildJob[]>;
  private readonly listQueuedJobIds: () => Promise<string[]>;
  private readonly queueMaxOverride?: number;

  constructor(deps?: BuildQueueDeps) {
    this.run = deps?.run ?? runBuildJob;
    this.cancelRun = deps?.cancelRun ?? cancelRunningBuild;
    this.isRunning = deps?.isRunning ?? isBuildRunning;
    this.requireScript = deps?.requireScript ?? requireWhitelistedScript;
    this.insert = deps?.insert ?? insertBuildJob;
    this.update = deps?.update ?? updateBuildJob;
    this.requireJob = deps?.requireJob ?? requireBuildJob;
    this.claimJob = deps?.claimJob ?? tryClaimBuildJobForRun;
    this.listRunningJobs =
      deps?.listRunningJobs ??
      (async () => listRunningBuildJobs());
    this.listQueuedJobIds =
      deps?.listQueuedJobIds ??
      (async () => (await listQueuedBuildJobs()).map((j) => j.id));
    this.queueMaxOverride = deps?.queueMax;
  }

  snapshot(): BuildQueueSnapshot {
    return {
      concurrency: 1,
      running: this.currentBuildId != null,
      currentBuildId: this.currentBuildId,
      queued: this.queuedIds.length,
      queuedIds: [...this.queuedIds],
      shuttingDown: this.shuttingDown,
    };
  }

  publishSnapshot(): void {
    publishBuildEvent({ type: "queue", snapshot: this.snapshot() });
  }

  async trigger(input: TriggerBuildInput): Promise<BuildJob> {
    if (this.shuttingDown) {
      throw new AppError(
        "Server is shutting down — not accepting new builds",
        503,
        "build_shutting_down",
      );
    }
    const script = await this.requireScript(input.scriptId);
    const max = Math.max(
      1,
      this.queueMaxOverride ?? getConfig().BUILD_QUEUE_MAX,
    );
    if (this.queuedIds.length >= max) {
      throw new AppError(
        `Build queue is full (${max})`,
        429,
        "build_queue_full",
      );
    }
    const note = input.note?.trim().slice(0, 200) || undefined;
    const job = createQueuedBuildJob({
      scriptId: script.id,
      scriptLabel: script.label,
      command: script.command,
      workingDir: script.workingDir,
      triggeredBy: input.triggeredBy,
      note,
    });
    await this.insert(job);
    this.queuedIds.push(job.id);
    logger.info("Build queued", {
      jobId: job.id,
      scriptId: script.id,
      triggeredBy: input.triggeredBy,
      queueLength: this.queuedIds.length,
    });
    publishBuildEvent({ type: "job", job });
    this.publishSnapshot();
    void this.pump();
    return job;
  }

  async cancel(jobId: string, reason = "Cancelled by user"): Promise<BuildJob> {
    const job = await this.requireJob(jobId);
    if (isTerminalBuildStatus(job.status)) {
      return job;
    }

    const queuedIdx = this.queuedIds.indexOf(jobId);
    if (queuedIdx >= 0) {
      this.queuedIds.splice(queuedIdx, 1);
      const updated = await this.update(jobId, {
        status: "cancelled",
        finishedAt: new Date().toISOString(),
        durationMs: 0,
        exitCode: null,
        errorMessage: reason,
        cancelRequested: true,
      });
      publishBuildEvent({ type: "job", job: updated });
      this.publishSnapshot();
      return updated;
    }

    if (this.currentBuildId === jobId || this.isRunning(jobId)) {
      await this.update(jobId, { cancelRequested: true });
      const sent = await this.cancelRun(jobId, reason);
      if (!sent) {
        const updated = await this.update(jobId, {
          status: "cancelled",
          finishedAt: new Date().toISOString(),
          errorMessage: reason,
          cancelRequested: true,
        });
        publishBuildEvent({ type: "job", job: updated });
        this.publishSnapshot();
        return updated;
      }
      return this.requireJob(jobId);
    }

    const updated = await this.update(jobId, {
      status: "cancelled",
      finishedAt: new Date().toISOString(),
      errorMessage: reason,
      cancelRequested: true,
    });
    publishBuildEvent({ type: "job", job: updated });
    this.publishSnapshot();
    return updated;
  }

  async restoreQueued(): Promise<number> {
    const interrupted = await markInterruptedBuildsFailed();
    if (interrupted > 0) {
      logger.warn("Marked interrupted builds as failed", { count: interrupted });
    }
    await this.syncQueuedFromDb();
    const restored = this.queuedIds.length;
    if (restored > 0) {
      logger.info("Restored queued builds after restart", { restored });
      this.publishSnapshot();
      void this.pump();
    }
    return restored;
  }

  async gracefulShutdown(timeoutMs = 15_000): Promise<void> {
    this.shuttingDown = true;
    const reason = "Cancelled — server shutting down";
    const waiting = [...this.queuedIds];
    this.queuedIds.length = 0;
    for (const id of waiting) {
      try {
        await this.update(id, {
          status: "cancelled",
          finishedAt: new Date().toISOString(),
          durationMs: 0,
          exitCode: null,
          errorMessage: reason,
          cancelRequested: true,
        });
      } catch (err) {
        logger.warn("Could not cancel queued build on shutdown", {
          id,
          err: String(err),
        });
      }
    }
    this.publishSnapshot();

    const current = this.currentBuildId;
    if (!current) return;

    await this.cancelRun(current, reason);
    const deadline = Date.now() + timeoutMs;
    while (this.currentBuildId && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 150));
    }
    if (this.currentBuildId) {
      logger.warn("Build still running after shutdown grace — giving up", {
        jobId: this.currentBuildId,
      });
    }
  }

  private async syncQueuedFromDb(): Promise<void> {
    const ids = await this.listQueuedJobIds();
    this.queuedIds.length = 0;
    this.queuedIds.push(...ids);
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (!this.shuttingDown) {
        await this.syncQueuedFromDb();
        if (this.queuedIds.length === 0) break;

        const running = await this.listRunningJobs();
        if (running.length > 0) {
          this.currentBuildId = running[0]?.id ?? this.currentBuildId;
          this.publishSnapshot();
          break;
        }

        const jobId = this.queuedIds[0];
        const claimed = await this.claimJob(jobId);
        if (!claimed) {
          await this.syncQueuedFromDb();
          continue;
        }

        this.queuedIds.shift();
        this.currentBuildId = jobId;
        publishBuildEvent({ type: "job", job: claimed });
        this.publishSnapshot();
        logger.info("Build dequeued — running", {
          jobId,
          triggeredBy: claimed.triggeredBy,
        });
        try {
          await this.run(jobId);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error("Build runner threw", { jobId, err: msg });
          try {
            const job = await this.update(jobId, {
              status: "failed",
              finishedAt: new Date().toISOString(),
              errorMessage: msg,
              exitCode: null,
            });
            publishBuildEvent({ type: "job", job });
          } catch {
            /* persist best-effort */
          }
        } finally {
          this.currentBuildId = null;
          this.publishSnapshot();
        }
      }
    } finally {
      this.pumping = false;
      await this.syncQueuedFromDb();
      const running = await this.listRunningJobs();
      if (this.queuedIds.length > 0 && !this.shuttingDown && running.length === 0) {
        void this.pump();
      }
    }
  }
}

export const buildQueue = new BuildQueue();
