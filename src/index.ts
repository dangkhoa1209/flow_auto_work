import { serve } from "@hono/node-server";
import { setMaxListeners } from "node:events";
import { getConfig } from "./config.js";
import { scanExistingAssignedIssues } from "./gitlab/startup-scan.js";
import { failInterruptedJobs } from "./job-store.js";
import { logger } from "./logger.js";
import { createApp } from "./server.js";

setMaxListeners(50);

async function main() {
  const config = getConfig();
  await failInterruptedJobs();
  const app = createApp();

  logger.info("Starting flow_auto_work", {
    host: config.HOST,
    port: config.PORT,
    repo: config.AIHR_REPO_PATH,
    project: config.ALLOWED_PROJECT_PATH,
    teamsEnabled: config.teamsEnabled,
    startupScan: config.STARTUP_SCAN,
  });

  serve(
    {
      fetch: app.fetch,
      hostname: config.HOST,
      port: config.PORT,
    },
    (info) => {
      logger.info(`Listening on http://${info.address}:${info.port}`);
      logger.info("Webhook path: POST /webhooks/gitlab");

      // Webhook listens immediately; then backfill existing assigned issues.
      void scanExistingAssignedIssues().catch((err) => {
        logger.error("Startup scan failed", { err: String(err) });
      });
    },
  );
}

main().catch((err) => {
  logger.error("Fatal startup error", { err: String(err) });
  process.exit(1);
});
