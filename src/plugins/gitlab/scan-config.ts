import { config as loadDotenv } from "dotenv";
import { z } from "zod";

loadDotenv();

/** Minimal config to list/scan GitLab issues without Cursor/Teams. */
const schema = z.object({
  GITLAB_BASE_URL: z.string().url().default("https://gitlab.com"),
  GITLAB_TOKEN: z.string().min(1),
  GITLAB_ASSIGNEE_USERNAME: z.string().min(1),
  ALLOWED_PROJECT_PATH: z.string().min(1),
  SKIP_LABELS: z.string().default("auto-work:skip,wip-human"),
});

function assertNotPlaceholder(name: string, value: string, bad: string[]) {
  const v = value.trim().toLowerCase();
  if (
    bad.some((b) => v === b.toLowerCase()) ||
    v.includes("...") ||
    v.includes("paste_") ||
    v.includes("your-") ||
    v.endsWith("_here")
  ) {
    throw new Error(
      `${name} is still a placeholder (${value}). Set your real value in .env`,
    );
  }
}

export function getGitlabScanConfig() {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(
      `Missing GitLab scan settings in .env:\n${details}\n\nRequired:\n` +
        `  GITLAB_TOKEN=glpat-<your real PAT with api scope>\n` +
        `  GITLAB_ASSIGNEE_USERNAME=<your GitLab username>\n` +
        `  ALLOWED_PROJECT_PATH=kiemnv/aihr_v3`,
    );
  }

  const env = parsed.data;
  assertNotPlaceholder("GITLAB_TOKEN", env.GITLAB_TOKEN, [
    "glpat-...",
    "change-me",
    "your-token",
  ]);
  assertNotPlaceholder(
    "GITLAB_ASSIGNEE_USERNAME",
    env.GITLAB_ASSIGNEE_USERNAME,
    ["your-gitlab-username", "username"],
  );

  return {
    ...env,
    skipLabels: env.SKIP_LABELS.split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  };
}
