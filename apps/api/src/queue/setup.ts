import { Queue } from "bullmq";
import type { ConnectionOptions } from "bullmq";
import type { CodeAgentJobData, DevopsBuildJobData } from "@flow/shared";

/** Shared Redis connection options for BullMQ Queues / Workers / QueueEvents. */
export function getRedisConnection(): ConnectionOptions {
  const host = (process.env.REDIS_HOST || "127.0.0.1").trim();
  const port = Number(process.env.REDIS_PORT || 6379);
  const password = process.env.REDIS_PASSWORD?.trim() || undefined;
  return {
    host,
    port: Number.isFinite(port) ? port : 6379,
    password,
    maxRetriesPerRequest: null,
  };
}

export const CODE_QUEUE_NAME = "code-agent-jobs";
export const BUILD_QUEUE_NAME = "devops-build-jobs";

/** Stable BullMQ job id for a Flow job (one active code item per jobId). */
export function bullmqCodeJobId(jobId: string): string {
  return `code-${jobId}`;
}

export function isDistributedQueueEnabled(): boolean {
  const v = (process.env.DISTRIBUTED_QUEUE || "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

let codeAgentQueue: Queue<CodeAgentJobData> | null = null;
let devopsBuildQueue: Queue<DevopsBuildJobData> | null = null;

export function getCodeAgentQueue(): Queue<CodeAgentJobData> {
  if (!codeAgentQueue) {
    codeAgentQueue = new Queue<CodeAgentJobData>(CODE_QUEUE_NAME, {
      connection: getRedisConnection(),
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: "exponential",
          delay: 5000,
        },
        removeOnComplete: { age: 86_400, count: 1000 },
        removeOnFail: { age: 604_800 },
      },
    });
  }
  return codeAgentQueue;
}

export function getDevopsBuildQueue(): Queue<DevopsBuildJobData> {
  if (!devopsBuildQueue) {
    devopsBuildQueue = new Queue<DevopsBuildJobData>(BUILD_QUEUE_NAME, {
      connection: getRedisConnection(),
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: { age: 86_400, count: 500 },
        removeOnFail: { age: 604_800 },
      },
    });
  }
  return devopsBuildQueue;
}

/** Ping Redis via a short-lived ioredis client. Throws if unreachable. */
export async function assertRedisReachable(): Promise<void> {
  const { Redis } = await import("ioredis");
  const c = getRedisConnection();
  const host = typeof c === "object" && c && "host" in c ? String(c.host) : "127.0.0.1";
  const port =
    typeof c === "object" && c && "port" in c ? Number(c.port) : 6379;
  const password =
    typeof c === "object" && c && "password" in c && c.password
      ? String(c.password)
      : undefined;
  const redis = new Redis({
    host,
    port,
    password,
    maxRetriesPerRequest: 1,
    connectTimeout: 5_000,
  });
  try {
    const pong = await redis.ping();
    if (pong !== "PONG") {
      throw new Error(`Redis ping failed: ${String(pong)}`);
    }
  } finally {
    try {
      await redis.quit();
    } catch {
      redis.disconnect();
    }
  }
}

export async function closeQueues(): Promise<void> {
  await Promise.all([
    codeAgentQueue?.close(),
    devopsBuildQueue?.close(),
  ]);
  codeAgentQueue = null;
  devopsBuildQueue = null;
}
