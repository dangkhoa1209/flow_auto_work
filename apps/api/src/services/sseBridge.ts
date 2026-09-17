/**
 * Bridge BullMQ QueueEvents → in-process realtime hub (SSE).
 * Every API instance boots this so multi-node SSE clients all receive progress.
 */
import { QueueEvents } from "bullmq";
import {
  CODE_QUEUE_NAME,
  getRedisConnection,
  isDistributedQueueEnabled,
} from "../queue/setup.js";
import { publishRealtime } from "../plugins/realtime/hub.js";
import { logger } from "../logger.js";

let queueEvents: QueueEvents | null = null;

type ProgressPayload = {
  log?: string;
  kind?: string;
  text?: string;
  timestamp?: number;
  line?: {
    id?: number;
    at?: string;
    kind?: string;
    text?: string;
  };
};

/**
 * Map worker progress updates onto the existing UI SSE contract (`progress`).
 */
export function startSseBridge(): void {
  if (!isDistributedQueueEnabled()) {
    logger.info("sseBridge skipped — DISTRIBUTED_QUEUE off");
    return;
  }
  if (queueEvents) return;

  queueEvents = new QueueEvents(CODE_QUEUE_NAME, {
    connection: getRedisConnection(),
  });

  queueEvents.on("progress", ({ jobId, data }) => {
    try {
      const payload = (data ?? {}) as ProgressPayload;
      const text =
        payload.line?.text ||
        payload.text ||
        payload.log ||
        (typeof data === "string" ? data : "");
      if (!text && !payload.line) return;

      // BullMQ jobId is `code-${flowJobId}` — strip prefix for hub/job store.
      const flowJobId =
        String(jobId || "").replace(/^code-/, "") || String(jobId);

      const line = payload.line ?? {
        id: Date.now(),
        at: new Date(payload.timestamp || Date.now()).toISOString(),
        kind: payload.kind || "log",
        text: String(text),
      };

      publishRealtime({
        type: "progress",
        jobId: flowJobId,
        line: {
          id: line.id ?? Date.now(),
          at: line.at ?? new Date().toISOString(),
          kind: line.kind ?? "log",
          text: line.text ?? String(text),
        },
        live: true,
      });
    } catch (err) {
      logger.warn("sseBridge progress handler failed", { err: String(err) });
    }
  });

  queueEvents.on("completed", ({ jobId }) => {
    const flowJobId = String(jobId || "").replace(/^code-/, "");
    if (!flowJobId) return;
    void import("../queue.js").then(({ jobQueue }) => {
      jobQueue.noteDistributedDone(flowJobId);
    });
    publishRealtime({
      type: "jobs",
      reason: "bullmq-completed",
      jobId: flowJobId,
    });
    publishRealtime({ type: "job", jobId: flowJobId });
  });

  queueEvents.on("failed", ({ jobId }) => {
    const flowJobId = String(jobId || "").replace(/^code-/, "");
    if (!flowJobId) return;
    void import("../queue.js").then(({ jobQueue }) => {
      jobQueue.noteDistributedDone(flowJobId);
    });
    publishRealtime({
      type: "jobs",
      reason: "bullmq-failed",
      jobId: flowJobId,
    });
    publishRealtime({ type: "job", jobId: flowJobId });
  });

  queueEvents.on("active", ({ jobId }) => {
    const flowJobId = String(jobId || "").replace(/^code-/, "");
    if (!flowJobId) return;
    void import("../queue.js").then(({ jobQueue }) => {
      jobQueue.noteDistributedActive(flowJobId);
    });
  });

  logger.info("sseBridge listening on QueueEvents", { queue: CODE_QUEUE_NAME });
}

export async function stopSseBridge(): Promise<void> {
  if (!queueEvents) return;
  await queueEvents.close();
  queueEvents = null;
}
