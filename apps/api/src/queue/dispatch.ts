/**
 * Dispatch CodeAgentJobData to BullMQ (API producer side).
 */
import type { CodeAgentJobData } from "@flow/shared";
import {
  bullmqCodeJobId,
  getCodeAgentQueue,
  isDistributedQueueEnabled,
} from "./setup.js";
import { clearJobAbortFlag } from "./abortSignal.js";
import { logger } from "../logger.js";

export async function enqueueCodeAgentJob(
  data: CodeAgentJobData,
): Promise<string> {
  if (!isDistributedQueueEnabled()) {
    throw new Error("DISTRIBUTED_QUEUE is not enabled");
  }

  const queue = getCodeAgentQueue();
  const id = bullmqCodeJobId(data.jobId);

  // Replace any leftover waiting/delayed job with the same id.
  // Do NOT clear abort while a prior job is still active (M1 race).
  const existing = await queue.getJob(id);
  if (existing) {
    const state = await existing.getState();
    if (state === "active") {
      throw new Error(
        `Job ${data.jobId} is still active on a worker — Force Stop and wait, then retry`,
      );
    }
    if (state === "waiting" || state === "delayed" || state === "prioritized") {
      await existing.remove();
    } else if (state === "completed" || state === "failed") {
      await existing.remove().catch(() => undefined);
    }
  }

  await clearJobAbortFlag(data.jobId);

  await queue.add(data.kind, data, { jobId: id });
  logger.info("Enqueued BullMQ code job", {
    bullmqJobId: id,
    jobId: data.jobId,
    kind: data.kind,
    ownerUsername: data.ownerUsername,
    projectId: data.projectId,
  });
  return id;
}

export async function removeCodeAgentBullJob(jobId: string): Promise<boolean> {
  if (!isDistributedQueueEnabled()) return false;
  const queue = getCodeAgentQueue();
  const id = bullmqCodeJobId(jobId);
  const job = await queue.getJob(id);
  if (!job) return false;
  const state = await job.getState();
  if (state === "active") {
    // Running — abort channel handles cancel; try moveToFailed if supported
    try {
      await job.discard();
    } catch {
      /* active jobs may not discard */
    }
    return true;
  }
  await job.remove();
  return true;
}
