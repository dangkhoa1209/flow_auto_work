/**
 * One-shot seed / ownership migrate — not run on server boot.
 *
 *   npm run seed
 */
import { getConfig } from "../src/config.js";
import { connectMongo, closeMongo } from "../src/db/mongo.js";
import { assignJobsToDefaultWorkspace } from "../src/job-store.js";
import { logger } from "../src/logger.js";
import { ensureAuthIndexes } from "../src/auth/sessions.js";
import { ensureWorkspaceIndexes } from "../src/workspace/store.js";
import {
  ensureWorkspaceSeed,
  SEED_PASSWORD,
  SEED_PROJECT,
  SEED_USERNAME,
  seedWorkspaceProjectId,
} from "../src/workspace/seed.js";

async function main() {
  getConfig();
  await connectMongo();
  await ensureWorkspaceIndexes();
  await ensureAuthIndexes();

  await ensureWorkspaceSeed();
  const owned = await assignJobsToDefaultWorkspace();

  logger.info("Seed done", {
    user: SEED_USERNAME,
    password: SEED_PASSWORD,
    project: SEED_PROJECT,
    workspaceProjectId: seedWorkspaceProjectId(),
    jobsAssigned: owned,
  });

  await closeMongo();
}

main().catch(async (err) => {
  logger.error("Seed failed", { err: String(err) });
  await closeMongo().catch(() => undefined);
  process.exit(1);
});
