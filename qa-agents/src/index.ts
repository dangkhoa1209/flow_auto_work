import { setMaxListeners } from "node:events";
import { connectMongo } from "../../src/db/mongo.js";
import { ensureAuthIndexes } from "../../src/auth/sessions.js";
import { ensureWorkspaceIndexes } from "../../src/workspace/store.js";
import { logger } from "../../src/logger.js";
import { getQaConfig } from "./config.js";
import { ensureQaIndexes } from "./store.js";
import { createQaApp } from "./app.js";
import { qaJobQueue } from "./queue.js";
import { cleanupOldArtifacts } from "./plugins/fs/cleanup.js";

setMaxListeners(100);

async function main() {
  const config = getQaConfig();
  logger.info("QA Agents config OK", { port: config.PORT });

  await connectMongo();
  await ensureWorkspaceIndexes();
  await ensureAuthIndexes();
  await ensureQaIndexes();
  logger.info("QA Agents database OK");

  await cleanupOldArtifacts();

  const restored = await qaJobQueue.restoreQueuedJobs();
  if (restored > 0) {
    logger.info(`Restored ${restored} queued QA job(s)`);
  }

  const app = await createQaApp();
  const host = config.HOST;
  const port = config.PORT;
  app.listen(port, host, () => {
    logger.info(`QA Agents OK — http://${host}:${port}/`);
  });
}

main().catch((err) => {
  logger.error("QA Agents fatal startup error", { err: String(err) });
  process.exit(1);
});
