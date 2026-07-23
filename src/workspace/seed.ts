import { logger } from "../logger.js";
import {
  createOrUpdateUserPassword,
  createUserProject,
  getProject,
  listProjectsForUser,
} from "./store.js";
import { defaultLocalPath, projectIdForUser } from "./types.js";

export const SEED_USERNAME = "khoadev";
export const SEED_PASSWORD = "Khoa.120900";
export const SEED_PROJECT = "ykk";

export function seedWorkspaceProjectId(): string {
  return projectIdForUser(SEED_USERNAME, SEED_PROJECT);
}

/** Idempotent seed: default user + initial project (CLI: `npm run seed`). */
export async function ensureWorkspaceSeed(): Promise<void> {
  // Always sync seed password so local resets stay consistent
  await createOrUpdateUserPassword({
    username: SEED_USERNAME,
    password: SEED_PASSWORD,
    displayName: "Khoa Dev",
  });
  logger.info("Seeded default user", { username: SEED_USERNAME });

  const projects = await listProjectsForUser(SEED_USERNAME);
  const hasYkk = projects.some(
    (p) => p.projectName.toLowerCase() === SEED_PROJECT,
  );
  if (!hasYkk) {
    const id = seedWorkspaceProjectId();
    if (!(await getProject(id))) {
      await createUserProject({
        username: SEED_USERNAME,
        projectName: SEED_PROJECT,
        gitlabPath: "example/ykk",
        localPath: defaultLocalPath(SEED_USERNAME, SEED_PROJECT),
        mainBranch: "main",
        isActive: true,
        displayName: "ykk",
      });
      logger.info("Seeded default project", {
        username: SEED_USERNAME,
        project: SEED_PROJECT,
      });
    }
  }
}
