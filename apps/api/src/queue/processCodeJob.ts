/**
 * Worker entry: run one CodeAgentJobData through JobQueue.execute paths.
 * Secrets are resolved inside runJob via withWorkspaceContext — never from Redis.
 */
import type { CodeAgentJobData } from "@flow/shared";
import { loadJob } from "../job-store.js";
import { logger } from "../logger.js";
import {
  isJobAbortFlagSet,
  subscribeJobAbort,
} from "./abortSignal.js";
import {
  cancelActiveAgentRun,
  markJobKillRequested,
} from "../plugins/agent/run.js";
import type { JobStatus } from "../types.js";

export class JobCancelledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobCancelledError";
  }
}

/**
 * Process a BullMQ code-agent job on the worker process.
 */
export async function processCodeAgentJob(
  data: CodeAgentJobData,
  opts?: {
    updateProgress?: (payload: {
      log?: string;
      kind?: string;
      text?: string;
      timestamp?: number;
    }) => Promise<void> | void;
  },
): Promise<{ status: string }> {
  const jobId = data.jobId;
  const onLog = async (msg: string) => {
    await opts?.updateProgress?.({
      log: msg,
      kind: "log",
      text: msg,
      timestamp: Date.now(),
    });
  };

  // M1: subscribe BEFORE any I/O / agent work
  let aborted = false;
  let abortReason = "Force-stopped from UI";
  const sub = await subscribeJobAbort(jobId, (reason) => {
    aborted = true;
    abortReason = reason || abortReason;
    markJobKillRequested(jobId);
    void import("../queue.js").then(({ jobQueue }) => {
      jobQueue.markJobKilled(jobId);
    });
    void cancelActiveAgentRun(jobId);
  });

  try {
    await onLog(`Worker picked up job ${jobId} (${data.kind})`);

    if (await isJobAbortFlagSet(jobId)) {
      throw new JobCancelledError(
        `Job ${jobId} was aborted before execution`,
      );
    }

    const { jobQueue } = await import("../queue.js");
    jobQueue.clearJobKilled(jobId);
    jobQueue.rememberJobScope({
      id: jobId,
      ownerUsername: data.ownerUsername,
      workspaceProjectId: data.projectId,
    });

    const job = await loadJob(jobId);
    if (!job) {
      throw new Error(`Job not found: ${jobId}`);
    }

    // M1 double-check immediately before agent path
    if (aborted || (await isJobAbortFlagSet(jobId))) {
      throw new JobCancelledError(
        `Job ${jobId} was aborted before execution`,
      );
    }

    const restore = data.followUpRestoreStatus as JobStatus | undefined;

    await onLog(`Executing kind=${data.kind}`);
    try {
      await jobQueue.executeDistributedItem({
        job,
        kind: data.kind,
        forceCodePhase: data.forceCodePhase,
        forceAgentPhase: data.forceAgentPhase,
        followUpMessage: data.followUpMessage,
        askOnlyMessage: data.askOnlyMessage,
        mergeTargetBranch: data.mergeTargetBranch,
        followUpRestoreStatus: restore,
        source: data.source,
      });
    } catch (err) {
      if (aborted || err instanceof JobCancelledError) {
        throw err instanceof JobCancelledError
          ? err
          : new JobCancelledError(abortReason);
      }
      throw err;
    }

    if (aborted) {
      throw new JobCancelledError(abortReason);
    }

    return { status: "SUCCESS" };
  } finally {
    await sub.unsubscribe();
  }
}
