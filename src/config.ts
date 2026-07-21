import { config as loadDotenv } from "dotenv";
import { z } from "zod";
import path from "node:path";

loadDotenv();

const envSchema = z.object({
  INGEST_MODE: z.enum(["webhook"]).default("webhook"),
  PORT: z.coerce.number().default(8787),
  HOST: z.string().default("127.0.0.1"),
  CURSOR_API_KEY: z.string().min(1),
  CURSOR_MODEL: z.string().default("composer-2.5"),
  AIHR_REPO_PATH: z.string().min(1),
  ALLOWED_PROJECT_PATH: z.string().min(1),
  GITLAB_BASE_URL: z.string().url().default("https://gitlab.com"),
  GITLAB_TOKEN: z.string().min(1),
  GITLAB_WEBHOOK_SECRET: z.string().min(1),
  GITLAB_ASSIGNEE_USERNAME: z.string().min(1),
  GITLAB_ASSIGNEE_ID: z.string().optional(),
  MR_TARGET_BRANCH: z.string().optional(),
  MR_REVIEWER_USERNAMES: z.string().optional(),
  SKIP_LABELS: z.string().default("auto-work:skip,wip-human"),
  TEAMS_TENANT_ID: z.string().optional(),
  TEAMS_CLIENT_ID: z.string().optional(),
  TEAMS_CLIENT_SECRET: z.string().optional(),
  TEAMS_CHAT_ID: z.string().optional(),
  TEAMS_USER_ID: z.string().optional(),
  TEAMS_CLARIFY_TIMEOUT_MIN: z.coerce.number().default(60),
  TEAMS_POLL_INTERVAL_SEC: z.coerce.number().default(20),
  MAX_CLARIFY_ROUNDS: z.coerce.number().default(3),
  DATA_DIR: z.string().default("./data"),
  STARTUP_SCAN: z
    .string()
    .optional()
    .transform((v) => v !== "false" && v !== "0"),
  STARTUP_SCAN_INCLUDE_SUCCEEDED: z
    .string()
    .optional()
    .transform((v) => v === "true" || v === "1"),
  // Paths excluded from auto commits (still tracked — NOT gitignore)
  COMMIT_EXCLUDE_PATHS: z
    .string()
    .default(
      "resources/js/composables/permission.js,resources/js/directives/index.js",
    ),
});

export type AppConfig = z.infer<typeof envSchema> & {
  skipLabels: string[];
  mrReviewerUsernames: string[];
  commitExcludePaths: string[];
  dataDir: string;
  teamsEnabled: boolean;
  STARTUP_SCAN: boolean;
  STARTUP_SCAN_INCLUDE_SUCCEEDED: boolean;
};

let cached: AppConfig | null = null;

export function getConfig(): AppConfig {
  if (cached) return cached;

  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid configuration:\n${details}`);
  }

  const env = parsed.data;
  const teamsEnabled = Boolean(
    env.TEAMS_TENANT_ID &&
      env.TEAMS_CLIENT_ID &&
      env.TEAMS_CLIENT_SECRET &&
      (env.TEAMS_CHAT_ID || env.TEAMS_USER_ID),
  );

  cached = {
    ...env,
    skipLabels: env.SKIP_LABELS.split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    mrReviewerUsernames: (env.MR_REVIEWER_USERNAMES ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    commitExcludePaths: env.COMMIT_EXCLUDE_PATHS.split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    dataDir: path.resolve(env.DATA_DIR),
    teamsEnabled,
  };

  // Fail fast on leftover .env.example placeholders (common cause of 401 on scan)
  const placeholders: Array<[string, string, string[]]> = [
    ["GITLAB_TOKEN", cached.GITLAB_TOKEN, ["glpat-...", "change-me"]],
    [
      "GITLAB_ASSIGNEE_USERNAME",
      cached.GITLAB_ASSIGNEE_USERNAME,
      ["your-gitlab-username"],
    ],
    ["CURSOR_API_KEY", cached.CURSOR_API_KEY, ["cursor_..."]],
    ["GITLAB_WEBHOOK_SECRET", cached.GITLAB_WEBHOOK_SECRET, ["change-me"]],
  ];
  for (const [name, value, bads] of placeholders) {
    const v = value.trim().toLowerCase();
    // Allow internal list-tasks dummies
    if (v.includes("list-tasks-placeholder-ok")) continue;
    if (
      bads.some((b) => v === b.toLowerCase()) ||
      v.includes("...") ||
      v.includes("paste_") ||
      v.includes("your-") ||
      v.endsWith("_here")
    ) {
      throw new Error(
        `${name} still looks like a placeholder (${value}). Edit .env with real values — see README "Scan existing tasks".`,
      );
    }
  }

  return cached;
}
