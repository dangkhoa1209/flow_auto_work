import { config as loadDotenv } from "dotenv";
import { z } from "zod";

loadDotenv();

const envSchema = z.object({
  PORT: z.coerce.number().default(8787),
  HOST: z.string().default("127.0.0.1"),
  /** Server master key to encrypt user GitLab/Cursor tokens at rest */
  FLOW_SECRETS_KEY: z.string().min(16),
  /** Optional legacy defaults — prefer per-user tokens in Mongo (encrypted) */
  CURSOR_API_KEY: z.string().optional(),
  AIHR_REPO_PATH: z.string().optional(),
  ALLOWED_PROJECT_PATH: z.string().optional(),
  GITLAB_BASE_URL: z.string().url().default("https://gitlab.com"),
  GITLAB_TOKEN: z.string().optional(),
  GITLAB_ASSIGNEE_USERNAME: z.string().optional(),
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
  STARTUP_SCAN: z
    .string()
    .optional()
    .transform((v) => v === "true" || v === "1"),
  STARTUP_SCAN_INCLUDE_SUCCEEDED: z
    .string()
    .optional()
    .transform((v) => v === "true" || v === "1"),
  DB_HOST: z.string().default("127.0.0.1"),
  DB_PORT: z.coerce.number().default(27017),
  DB_DATABASE: z.string().default("flow_auto_work"),
  DB_USERNAME: z.string().optional(),
  DB_PASSWORD: z.string().optional(),
  ON_COMPLETE_ASSIGN_USERNAMES: z.string().optional(),
  ON_COMPLETE_LABELS: z.string().optional(),
  ON_COMPLETE_COMMENT: z.string().optional(),
});

export type AppConfig = z.infer<typeof envSchema> & {
  skipLabels: string[];
  mrReviewerUsernames: string[];
  onCompleteAssignUsernames: string[];
  onCompleteLabels: string[];
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
    onCompleteAssignUsernames: (env.ON_COMPLETE_ASSIGN_USERNAMES ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    onCompleteLabels: (env.ON_COMPLETE_LABELS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    teamsEnabled,
  };

  // Fail fast on leftover .env.example placeholders (common cause of 401 on scan)
  const placeholders: Array<[string, string | undefined, string[]]> = [
    ["GITLAB_TOKEN", cached.GITLAB_TOKEN, ["glpat-...", "change-me"]],
    [
      "GITLAB_ASSIGNEE_USERNAME",
      cached.GITLAB_ASSIGNEE_USERNAME,
      ["your-gitlab-username"],
    ],
    ["CURSOR_API_KEY", cached.CURSOR_API_KEY, ["cursor_..."]],
    ["FLOW_SECRETS_KEY", cached.FLOW_SECRETS_KEY, ["change-me", "replace-me"]],
  ];
  for (const [name, value, bads] of placeholders) {
    if (value == null || !String(value).trim()) continue;
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

/** Build mongodb:// URI from DB_* env parts (auth optional). */
export function buildMongoUri(cfg = getConfig()): string {
  const host = cfg.DB_HOST.trim();
  const port = cfg.DB_PORT;
  const user = cfg.DB_USERNAME?.trim();
  const pass = cfg.DB_PASSWORD;
  if (user) {
    const u = encodeURIComponent(user);
    const p = encodeURIComponent(pass ?? "");
    return `mongodb://${u}:${p}@${host}:${port}`;
  }
  return `mongodb://${host}:${port}`;
}
