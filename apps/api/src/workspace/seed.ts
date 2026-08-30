import { logger } from "../logger.js";
import { createOrUpdateUserPassword } from "./store.js";
import { projectIdForUser } from "./types.js";

/** Legacy defaults still referenced by job-store migrate helpers — not seeded. */
export const SEED_USERNAME = "khoadev";
export const SEED_PASSWORD = "Khoa.120900";
export const SEED_PROJECT = "ykk";

export const ADMIN_USERNAME = "admin";
export const ADMIN_PASSWORD = "Khoa.120900";

export function seedWorkspaceProjectId(): string {
  return projectIdForUser(SEED_USERNAME, SEED_PROJECT);
}

/** Idempotent seed: admin account only (CLI: `npm run seed`). Does not touch projects. */
export async function ensureWorkspaceSeed(): Promise<void> {
  await createOrUpdateUserPassword({
    username: ADMIN_USERNAME,
    password: ADMIN_PASSWORD,
    displayName: "Admin",
    roles: ["admin"],
  });
  logger.info("Seeded admin user", { username: ADMIN_USERNAME });
}
