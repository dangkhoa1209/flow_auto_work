/**
 * Cross-process Force Stop via Redis Pub/Sub + durable key (M1 mitigation).
 * Uses a dedicated ioredis connection — never share BullMQ's connection for SUBSCRIBE.
 */
import { Redis } from "ioredis";
import { logger } from "../logger.js";

const ABORT_CHANNEL_PREFIX = "job:abort:";
const ABORT_KEY_PREFIX = "job:abort:";
/** Durable abort flag TTL (7 days) — cleaned on successful start clear or expire. */
const ABORT_KEY_TTL_SEC = 7 * 24 * 3600;

function abortChannel(jobId: string): string {
  return `${ABORT_CHANNEL_PREFIX}${jobId}`;
}

function abortKey(jobId: string): string {
  return `${ABORT_KEY_PREFIX}${jobId}`;
}

type RedisTcpOpts = {
  host: string;
  port: number;
  password?: string;
  maxRetriesPerRequest: null;
  enableReadyCheck: boolean;
};

function connectionOpts(): RedisTcpOpts {
  const host = (process.env.REDIS_HOST || "127.0.0.1").trim();
  const port = Number(process.env.REDIS_PORT || 6379);
  const password = process.env.REDIS_PASSWORD?.trim() || undefined;
  return {
    host,
    port: Number.isFinite(port) ? port : 6379,
    password,
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  };
}

let publisher: Redis | null = null;

function getPublisher(): Redis {
  if (!publisher) {
    publisher = new Redis(connectionOpts());
    publisher.on("error", (err: Error) => {
      logger.warn("abortSignal publisher redis error", { err: String(err) });
    });
  }
  return publisher;
}

/**
 * API Force Stop: set durable key + PUBLISH so workers that already SUBSCRIBE wake up.
 */
export async function publishJobAbort(
  jobId: string,
  reason = "Force-stopped from UI",
): Promise<void> {
  const id = jobId.trim();
  if (!id) return;
  const redis = getPublisher();
  await redis.set(abortKey(id), reason, "EX", ABORT_KEY_TTL_SEC);
  await redis.publish(abortChannel(id), reason);
  logger.warn("Published job abort", { jobId: id, reason });
}

/** Clear durable abort flag (e.g. after successful enqueue of a fresh run). */
export async function clearJobAbortFlag(jobId: string): Promise<void> {
  const id = jobId.trim();
  if (!id) return;
  try {
    await getPublisher().del(abortKey(id));
  } catch (err) {
    logger.warn("clearJobAbortFlag failed", { jobId: id, err: String(err) });
  }
}

/** Durable check — survives missed Pub/Sub (M1 double-check). */
export async function isJobAbortFlagSet(jobId: string): Promise<boolean> {
  const id = jobId.trim();
  if (!id) return false;
  const n = await getPublisher().exists(abortKey(id));
  return n === 1;
}

export type AbortSubscription = {
  unsubscribe: () => Promise<void>;
};

/**
 * Worker: SUBSCRIBE before any I/O/agent work. Callback runs on abort message.
 */
export async function subscribeJobAbort(
  jobId: string,
  onAbort: (reason: string) => void,
): Promise<AbortSubscription> {
  const id = jobId.trim();
  const channel = abortChannel(id);
  const sub = new Redis(connectionOpts());
  sub.on("error", (err: Error) => {
    logger.warn("abortSignal subscriber redis error", {
      jobId: id,
      err: String(err),
    });
  });

  await sub.subscribe(channel);
  sub.on("message", (ch: string, message: string) => {
    if (ch !== channel) return;
    onAbort(message || "Force-stopped from UI");
  });

  return {
    unsubscribe: async () => {
      try {
        await sub.unsubscribe(channel);
      } catch {
        /* ignore */
      }
      try {
        await sub.quit();
      } catch {
        try {
          sub.disconnect();
        } catch {
          /* ignore */
        }
      }
    },
  };
}

export async function closeAbortPublisher(): Promise<void> {
  if (!publisher) return;
  try {
    await publisher.quit();
  } catch {
    publisher.disconnect();
  }
  publisher = null;
}
