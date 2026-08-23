import "./plugins/agent/abortSignalPatch.js";
import { setMaxListeners } from "node:events";
import { isTransientCursorTransportError } from "./plugins/agent/run.js";
import { getConfig } from "./config.js";
import { connectMongo } from "./db/mongo.js";
import {
  failInterruptedJobs,
  resolveLegacyDiffApprovalJobs,
} from "./job-store.js";
import { logger } from "./logger.js";
import { startHttpServer } from "./server.js";
import { ensureWorkspaceIndexes } from "./workspace/store.js";
import { ensureAuthIndexes } from "./auth/sessions.js";

setMaxListeners(100);

/** Orphaned Cursor HTTP/2 errors must not kill the server. */
process.on("unhandledRejection", (reason) => {
  if (isTransientCursorTransportError(reason)) {
    logger.warn("Cursor transport error (unhandledRejection ignored)", {
      err: String(reason),
    });
    return;
  }
  logger.error("Unhandled rejection", { err: String(reason) });
});

process.on("uncaughtException", (err) => {
  if (isTransientCursorTransportError(err)) {
    logger.warn("Cursor transport error (uncaughtException ignored)", {
      err: String(err),
    });
    return;
  }
  logger.error("Uncaught exception", { err: String(err) });
  process.exit(1);
});

async function main() {
  const config = getConfig();
  logger.info("Config OK");

  await connectMongo();
  logger.info("Database OK");

  await ensureWorkspaceIndexes();
  await ensureAuthIndexes();
  const { ensureBaIndexes } = await import("./workspace/baStore.js");
  await ensureBaIndexes();
  logger.info("Workspace + auth indexes OK");

  await failInterruptedJobs();
  const legacy = await resolveLegacyDiffApprovalJobs();
  if (legacy > 0) {
    logger.info(`Migrated ${legacy} legacy job(s)`);
  }
  logger.info("Job store OK");

  // Requeue jobs that were still waiting in queue when the process died
  const { jobQueue } = await import("./queue.js");
  const restored = await jobQueue.restoreQueuedJobs();
  if (restored > 0) {
    logger.info(`Restored ${restored} queued job(s) after restart`);
  }

  await startHttpServer();
}

main().catch((err) => {
  logger.error("Fatal startup error", { err: String(err) });
  process.exit(1);
});
