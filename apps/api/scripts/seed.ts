/**
 * One-shot seed — creates admin account only. Does not touch projects.
 *
 *   npm run seed
 */
import { getConfig } from "../src/config.js";
import { connectMongo, closeMongo } from "../src/models/connection.js";
import { logger } from "../src/logger.js";
import { ensureAuthIndexes } from "../src/auth/sessions.js";
import { ensureWorkspaceIndexes } from "../src/workspace/store.js";
import {
  ensureWorkspaceSeed,
  ADMIN_PASSWORD,
  ADMIN_USERNAME,
} from "../src/workspace/seed.js";
import { ensureBaIndexes } from "../src/workspace/baStore.js";

async function main() {
  getConfig();
  await connectMongo();
  await ensureWorkspaceIndexes();
  await ensureAuthIndexes();
  await ensureBaIndexes();

  await ensureWorkspaceSeed();

  logger.info("Seed done", {
    adminUser: ADMIN_USERNAME,
    adminPassword: ADMIN_PASSWORD,
  });

  await closeMongo();
}

main().catch(async (err) => {
  logger.error("Seed failed", { err: String(err) });
  await closeMongo().catch(() => undefined);
  process.exit(1);
});
