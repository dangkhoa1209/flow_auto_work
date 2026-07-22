import { serve } from "@hono/node-server";
import { setMaxListeners } from "node:events";
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

setMaxListeners(50);

async function main() {
  const config = getConfig();
  await applyGitlabAssigneeFromEnvToken();
  await connectMongo();
  await ensureWorkspaceIndexes();
  await failInterruptedJobs();
  const legacy = await resolveLegacyDiffApprovalJobs();
  if (legacy > 0) {
    logger.info("Migrated legacy diff-approval jobs to succeeded", {
      count: legacy,
    });
  }
  const app = createApp();

  logger.info("Starting flow_auto_work", {
    host: config.HOST,
    port: config.PORT,
    multiUser: true,
    secretsEncrypted: true,
    gitlabAssignee: config.GITLAB_ASSIGNEE_USERNAME ?? null,
    legacyRepo: config.AIHR_REPO_PATH ?? null,
    legacyProject: config.ALLOWED_PROJECT_PATH ?? null,
    teamsEnabled: config.teamsEnabled,
    webhookAutoEnqueue: config.WEBHOOK_AUTO_ENQUEUE,
    mongo: config.MONGODB_URI,
    ui: `http://${config.HOST}:${config.PORT}/`,
  });

  serve(
    {
      fetch: app.fetch,
      hostname: config.HOST,
      port: config.PORT,
    },
    (info) => {
      logger.info(`Listening on http://${info.address}:${info.port}`);
      logger.info(`UI: http://${info.address}:${info.port}/`);
      logger.info(
        "Multi-user: login with GitLab username + encrypted tokens; join projects; paste work branch",
      );
      if (config.WEBHOOK_AUTO_ENQUEUE) {
        logger.info("Webhook auto-enqueue: ON");
      } else {
        logger.info("Webhook auto-enqueue: OFF (UI-only)");
      }
    },
  );
}

main().catch((err) => {
  logger.error("Fatal startup error", { err: String(err) });
  process.exit(1);
});
