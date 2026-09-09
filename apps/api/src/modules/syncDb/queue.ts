import { getConfig } from "../../config.js";
import { logger } from "../../logger.js";
import { AppError } from "../../utils/AppError.js";
import {
  getBaProject,
  resolveBaProjectDb,
} from "../../workspace/baStore.js";
import { publishSyncDbEvent, subscribeSyncDbEvents } from "./events.js";
import {
  cancelRunningSyncDb,
  isSyncDbRunning,
  runSyncDbJob,
} from "./runner.js";
import { assertSafeRestoreTarget } from "./safety.js";
import {
  createQueuedSyncDbJob,
  findActiveJobForProject,
  insertSyncDbJob,
  listQueuedSyncDbJobs,
  listRunningSyncDbJobs,
  requeueInterruptedSyncDbJobs,
  requireSyncDbJob,
  requireSyncDbJobForProject,
  tryClaimSyncDbJobForRun,
  updateSyncDbJob,
} from "./store.js";
import {
  isSyncDbSystemReady,
  getSyncDbSystemConfig,
  resolveSyncDbSystemConfig,
} from "./systemConfig.js";
import {
  emptyProgress,
  isTerminalSyncDbStatus,
  type SyncDbJob,
  type SyncDbQueueSnapshot,
} from "./types.js";

export type TriggerSyncDbInput = {
  projectId: string;
  triggeredBy: string;
};

/**
 * In-process pump for a **system-wide** FIFO sync queue (concurrency = 1).
 * Separate from Devops BuildQueue so dumps never block builds and vice versa.
 */
export class SyncDbQueue {
  private readonly queuedIds: string[] = [];
  private currentJobId: string | null = null;
  private currentDbName: string | null = null;
  private currentProgress = emptyProgress();
  private pumping = false;
  private shuttingDown = false;

  snapshot(): SyncDbQueueSnapshot {
    return {
      concurrency: 1,
      running: this.currentJobId != null,
      currentJobId: this.currentJobId,
      currentDbName: this.currentDbName,
      currentProgress: this.currentJobId ? this.currentProgress : null,
      queued: this.queuedIds.length,
      queuedIds: [...this.queuedIds],
      shuttingDown: this.shuttingDown,
    };
  }

  publishSnapshot(): void {
    publishSyncDbEvent({ type: "queue", snapshot: this.snapshot() });
  }

  async trigger(input: TriggerSyncDbInput): Promise<SyncDbJob> {
    if (this.shuttingDown) {
      throw new AppError(
        "Server is shutting down — not accepting new sync jobs",
        503,
        "sync_db_shutting_down",
      );
    }

    const cfg = await getSyncDbSystemConfig();
    if (!isSyncDbSystemReady(cfg)) {
      throw new AppError(
        "Sync Database is not configured or disabled",
        409,
        "sync_db_not_configured",
      );
    }

    const project = await getBaProject(input.projectId);
    if (!project) {
      throw new AppError("Project not found", 404, "project_not_found");
    }
    const db = project.db;
    if (!db?.enabled || !db.host || !db.database) {
      throw new AppError(
        "Project has no Connect DB — configure MongoDB first",
        409,
        "sync_db_project_no_db",
      );
    }
    if (db.dialect !== "mongodb") {
      throw new AppError(
        "Sync Database only supports MongoDB projects",
        409,
        "sync_db_not_mongo",
      );
    }

    // Fail fast before enqueue — same live-safety rules as the runner.
    const target = await resolveBaProjectDb(project.id);
    if (!target) {
      throw new AppError(
        "Project DB connection missing",
        409,
        "sync_db_project_no_db",
      );
    }
    const source = await resolveSyncDbSystemConfig();
    assertSafeRestoreTarget(target, source);

    const dup = await findActiveJobForProject(project.id);
    if (dup) {
      throw new AppError(
        `Sync already queued/running for this project (${dup.dbName})`,
        409,
        "sync_db_project_busy",
      );
    }

    const max = Math.max(1, getConfig().SYNC_DB_QUEUE_MAX);
    if (this.queuedIds.length >= max) {
      throw new AppError(
        `Sync DB queue is full (${max})`,
        429,
        "sync_db_queue_full",
      );
    }

    const job = createQueuedSyncDbJob({
      projectId: project.id,
      projectName: project.displayName,
      dbName: db.database,
      triggeredBy: input.triggeredBy,
      targetHost: db.host,
      targetPort: db.port,
    });
    await insertSyncDbJob(job);
    this.queuedIds.push(job.id);
    logger.info("Sync DB queued", {
      jobId: job.id,
      projectId: project.id,
      dbName: job.dbName,
      triggeredBy: input.triggeredBy,
      queueLength: this.queuedIds.length,
    });
    publishSyncDbEvent({ type: "job", job });
    this.publishSnapshot();
    void this.pump();
    return job;
  }

  async cancel(
    jobId: string,
    reason = "Cancelled by user",
    opts?: { projectId?: string },
  ): Promise<SyncDbJob> {
    const projectId = String(opts?.projectId || "").trim();
    if (!projectId) {
      throw new AppError(
        "projectId required to cancel a sync job",
        400,
        "sync_db_project_required",
      );
    }
    const job = await requireSyncDbJobForProject(jobId, projectId);
    if (isTerminalSyncDbStatus(job.status)) return job;

    const queuedIdx = this.queuedIds.indexOf(jobId);
    if (queuedIdx >= 0) {
      this.queuedIds.splice(queuedIdx, 1);
      const updated = await updateSyncDbJob(jobId, {
        status: "cancelled",
        finishedAt: new Date().toISOString(),
        durationMs: 0,
        exitCode: null,
        errorMessage: reason,
        cancelRequested: true,
        progress: { ...job.progress, phase: "failed", current: [] },
      });
      publishSyncDbEvent({ type: "job", job: updated });
      this.publishSnapshot();
      return updated;
    }

    if (this.currentJobId === jobId || isSyncDbRunning(jobId)) {
      await updateSyncDbJob(jobId, { cancelRequested: true });
      const sent = await cancelRunningSyncDb(jobId, reason);
      if (!sent) {
        const updated = await updateSyncDbJob(jobId, {
          status: "cancelled",
          finishedAt: new Date().toISOString(),
          errorMessage: reason,
          cancelRequested: true,
        });
        publishSyncDbEvent({ type: "job", job: updated });
        this.publishSnapshot();
        return updated;
      }
      return this.requireJob(jobId);
    }

    const updated = await updateSyncDbJob(jobId, {
      status: "cancelled",
      finishedAt: new Date().toISOString(),
      errorMessage: reason,
      cancelRequested: true,
    });
    publishSyncDbEvent({ type: "job", job: updated });
    this.publishSnapshot();
    return updated;
  }

  private async requireJob(id: string) {
    return requireSyncDbJob(id);
  }

  async restoreQueued(): Promise<number> {
    const interrupted = await requeueInterruptedSyncDbJobs();
    if (interrupted > 0) {
      logger.warn("Re-queued interrupted sync-db jobs after restart", {
        count: interrupted,
      });
    }
    await this.syncQueuedFromDb();
    const restored = this.queuedIds.length;
    if (restored > 0) {
      logger.info("Restored queued sync-db jobs after restart", { restored });
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
        await updateSyncDbJob(id, {
          status: "cancelled",
          finishedAt: new Date().toISOString(),
          durationMs: 0,
          exitCode: null,
          errorMessage: reason,
          cancelRequested: true,
        });
      } catch (err) {
        logger.warn("Could not cancel queued sync-db on shutdown", {
          id,
          err: String(err),
        });
      }
    }
    this.publishSnapshot();

    const current = this.currentJobId;
    if (!current) return;

    await cancelRunningSyncDb(current, reason);
    const deadline = Date.now() + timeoutMs;
    while (this.currentJobId && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  private async syncQueuedFromDb(): Promise<void> {
    const ids = (await listQueuedSyncDbJobs()).map((j) => j.id);
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

        const running = await listRunningSyncDbJobs();
        if (running.length > 0) {
          this.currentJobId = running[0]?.id ?? this.currentJobId;
          this.currentDbName = running[0]?.dbName ?? this.currentDbName;
          this.currentProgress = running[0]?.progress ?? this.currentProgress;
          this.publishSnapshot();
          break;
        }

        const jobId = this.queuedIds[0];
        const claimed = await tryClaimSyncDbJobForRun(jobId);
        if (!claimed) {
          await this.syncQueuedFromDb();
          continue;
        }

        this.queuedIds.shift();
        this.currentJobId = jobId;
        this.currentDbName = claimed.dbName;
        this.currentProgress = claimed.progress;
        publishSyncDbEvent({ type: "job", job: claimed });
        this.publishSnapshot();

        const unsub = publishProgressMirror(jobId, (p) => {
          this.currentProgress = p;
          this.publishSnapshot();
        });

        try {
          const target = await resolveBaProjectDb(claimed.projectId);
          if (!target) {
            throw new AppError(
              "Project DB connection missing at run time",
              409,
              "sync_db_project_no_db",
            );
          }
          await runSyncDbJob(jobId, target);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error("Sync DB runner threw", { jobId, err: msg });
          try {
            const job = await updateSyncDbJob(jobId, {
              status: "failed",
              finishedAt: new Date().toISOString(),
              errorMessage: msg,
              exitCode: null,
              progress: {
                ...this.currentProgress,
                phase: "failed",
                current: [],
              },
            });
            publishSyncDbEvent({ type: "job", job });
            publishSyncDbEvent({ type: "done", jobId, job });
          } catch {
            /* best-effort */
          }
        } finally {
          unsub();
          this.currentJobId = null;
          this.currentDbName = null;
          this.currentProgress = emptyProgress();
          this.publishSnapshot();
        }
      }
    } finally {
      this.pumping = false;
      await this.syncQueuedFromDb();
      const running = await listRunningSyncDbJobs();
      if (
        this.queuedIds.length > 0 &&
        !this.shuttingDown &&
        running.length === 0
      ) {
        void this.pump();
      }
    }
  }
}

function publishProgressMirror(
  jobId: string,
  onProgress: (p: SyncDbJob["progress"]) => void,
): () => void {
  return subscribeSyncDbEvents((ev) => {
    if (ev.type === "progress" && ev.jobId === jobId) {
      onProgress(ev.progress);
    }
    if (ev.type === "job" && ev.job.id === jobId) {
      onProgress(ev.job.progress);
    }
  });
}

export const syncDbQueue = new SyncDbQueue();
