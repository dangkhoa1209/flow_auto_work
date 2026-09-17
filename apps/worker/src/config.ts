/**
 * Worker Redis / concurrency config (mirrors apps/api/src/queue/setup.ts names).
 */
import type { ConnectionOptions } from "bullmq";

export const CODE_QUEUE_NAME = "code-agent-jobs";
export const BUILD_QUEUE_NAME = "devops-build-jobs";

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

export function workerConcurrency(): number {
  const n = Number(process.env.WORKER_CONCURRENCY || 3);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 3;
}

export function worktreeRoot(): string {
  return (
    process.env.WORKTREE_ROOT?.trim() ||
    "/tmp/workspaces"
  );
}

export function repoCacheRoot(): string {
  return (
    process.env.REPO_CACHE_ROOT?.trim() ||
    ""
  );
}
