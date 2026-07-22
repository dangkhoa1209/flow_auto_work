import { serve } from "@hono/node-server";
import { setMaxListeners } from "node:events";
import { isTransientCursorTransportError } from "./agent/run.js";
import { getConfig } from "./config.js";
import { connectMongo } from "./db/mongo.js";
import {
  failInterruptedJobs,
  resolveLegacyDiffApprovalJobs,
} from "./job-store.js";
import { logger } from "./logger.js";
import { createApp } from "./server.js";
import { ensureWorkspaceIndexes } from "./workspace/store.js";
import { applyGitlabAssigneeFromEnvToken } from "./gitlab/identity.js";
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

  await applyGitlabAssigneeFromEnvToken();
  await connectMongo();
  logger.info("Database OK");

  await ensureWorkspaceIndexes();
  await ensureAuthIndexes();
  logger.info("Workspace indexes OK");

  await failInterruptedJobs();
  const legacy = await resolveLegacyDiffApprovalJobs();
  if (legacy > 0) {
    logger.info(`Migrated ${legacy} legacy job(s)`);
  }
  logger.info("Job store OK");

  const app = createApp();
  serve(
    {
      fetch: app.fetch,
      hostname: config.HOST,
      port: config.PORT,
    },
    (info) => {
      logger.info(`Server OK — http://${info.address}:${info.port}/`);
    },
  );
}

main().catch((err) => {
  logger.error("Fatal startup error", { err: String(err) });
  process.exit(1);
});
