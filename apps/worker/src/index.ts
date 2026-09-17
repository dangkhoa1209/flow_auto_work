/**
 * BullMQ consumer for code-agent-jobs.
 * Requires DISTRIBUTED_QUEUE=1 on API + Redis + same Mongo / FLOW_SECRETS_KEY as API.
 */
import "./loadEnv.js";
import { Worker, type Job } from "bullmq";
import type { CodeAgentJobData } from "@flow/shared";
import { connectMongo } from "../../api/src/models/connection.js";
import { getConfig } from "../../api/src/config.js";
import { logger } from "../../api/src/logger.js";
import {
  JobCancelledError,
} from "../../api/src/queue/processCodeJob.js";
import {
  CODE_QUEUE_NAME,
  getRedisConnection,
  workerConcurrency,
} from "./config.js";
import { runCursorAgentPipeline } from "./pipelines/agentRunner.js";

async function main() {
  // Validate shared secrets / DB config (same env as API)
  getConfig();
  await connectMongo();
  logger.info("Worker database OK");

  const concurrency = workerConcurrency();
  const worker = new Worker<CodeAgentJobData>(
    CODE_QUEUE_NAME,
    async (job: Job<CodeAgentJobData>) => {
      const data = job.data;
      logger.info("Processing code job", {
        bullmqId: job.id,
        jobId: data.jobId,
        kind: data.kind,
        user: data.ownerUsername,
        pid: process.pid,
      });

      const { setJobProgressForwarder } = await import(
        "../../api/src/plugins/agent/progress.js"
      );
      setJobProgressForwarder(data.jobId, (flowJobId, line) => {
        if (flowJobId !== data.jobId) return;
        void job.updateProgress({
          line,
          log: line.text,
          text: line.text,
          kind: line.kind,
          timestamp: Date.now(),
        });
      });

      try {
        return await runCursorAgentPipeline(data, async (progressLog) => {
          await job.updateProgress({
            log: progressLog,
            text: progressLog,
            kind: "log",
            timestamp: Date.now(),
          });
        });
      } finally {
        setJobProgressForwarder(data.jobId, null);
      }
    },
    {
      connection: getRedisConnection(),
      concurrency,
      limiter: {
        max: 10,
        duration: 60_000,
      },
    },
  );

  worker.on("completed", (job) => {
    logger.info("Job succeeded", { bullmqId: job.id, jobId: job.data.jobId });
  });

  worker.on("failed", (job, err) => {
    const cancelled = err instanceof JobCancelledError;
    logger.error("Job failed", {
      bullmqId: job?.id,
      jobId: job?.data?.jobId,
      cancelled,
      err: err.message,
    });
  });

  logger.info("Worker listening", {
    queue: CODE_QUEUE_NAME,
    concurrency,
    pid: process.pid,
  });

  const shutdown = async () => {
    logger.info("Worker shutting down…");
    await worker.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((err) => {
  console.error("Worker fatal startup error", err);
  process.exit(1);
});
