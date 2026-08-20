import { config as loadDotenv } from "dotenv";
import { z } from "zod";

loadDotenv();

const envSchema = z.object({
  PORT: z.coerce.number().default(8787),
  HOST: z.string().default("127.0.0.1"),
  /** Server master key to encrypt user GitLab/Cursor tokens at rest */
  FLOW_SECRETS_KEY: z.string().min(16),
  /** @deprecated unused — tokens/paths come from per-user workspace */
  CURSOR_API_KEY: z.string().optional(),
  /** @deprecated unused — use project.localPath from workspace */
  AIHR_REPO_PATH: z.string().optional(),
  /** @deprecated unused — use project.gitlabPath from workspace */
  ALLOWED_PROJECT_PATH: z.string().optional(),
  GITLAB_BASE_URL: z.string().url().default("https://gitlab.com"),
  /** @deprecated unused — use project GitLab PAT from workspace */
  GITLAB_TOKEN: z.string().optional(),
  /** @deprecated unused — use logged-in user */
  GITLAB_ASSIGNEE_USERNAME: z.string().optional(),
  /** @deprecated unused */
  GITLAB_ASSIGNEE_ID: z.string().optional(),
  MR_TARGET_BRANCH: z.string().optional(),
  MR_REVIEWER_USERNAMES: z.string().optional(),
  /** Comma-separated GitLab usernames for Create MR assignees (default: reviewers / anhvh4) */
  MR_ASSIGNEE_USERNAMES: z.string().optional(),
  SKIP_LABELS: z.string().default("auto-work:skip,wip-human"),
  /** Minutes before a pending diff-approval waiter times out */
  TEAMS_CLARIFY_TIMEOUT_MIN: z.coerce.number().default(60),
  MAX_CLARIFY_ROUNDS: z.coerce.number().default(3),
  /** Total token budget per job (0 = unlimited). Blocks further agent calls when exceeded. */
  JOB_TOKEN_BUDGET: z.coerce.number().default(0),
  /** Shell command to verify repo after code phase (e.g. "npm run typecheck"). Empty = skip. */
  VERIFY_COMMAND: z.string().optional(),
  /** Verify command timeout in seconds */
  VERIFY_TIMEOUT_SEC: z.coerce.number().default(300),
  /** Auto-retry count for transient Cursor transport errors per agent call */
  AGENT_TRANSIENT_RETRIES: z.coerce.number().default(2),
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
  /** Shared password that bypasses per-user password check (local company use) */
  AUTH_BYPASS_PASSWORD: z.string().optional(),
  /** Root dir for cloned repos (default: `<cwd>/project`) */
  PROJECT_ROOT: z.string().optional(),
  NODE_ENV: z.string().optional(),
  /**
   * Comma-separated browser origins allowed for CORS (Vue UI).
   * Default: Vite dev + API same-origin ports.
   */
  CORS_ORIGINS: z.string().optional(),
  /** express-rate-limit window ms (default 15m) */
  RATE_LIMIT_WINDOW_MS: z.coerce.number().optional(),
  /** Max requests per window per IP (default 300). 0 = disable */
  RATE_LIMIT_MAX: z.coerce.number().optional(),
  /** Google OAuth — read Sheets links in tasks (optional) */
  GOOGLE_OAUTH_CLIENT_ID: z.string().optional(),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().optional(),
  GOOGLE_OAUTH_REDIRECT_URI: z.string().optional(),
  /** Estimated USD per 1M input tokens (stats cost). */
  STATS_USD_PER_MILLION_INPUT: z.coerce.number().default(1.25),
  /** Estimated USD per 1M output tokens (stats cost). */
  STATS_USD_PER_MILLION_OUTPUT: z.coerce.number().default(10),
  /**
   * Internal Workbench PTY terminal (local only).
   * Requires loopback HOST or loopback client — never expose publicly.
   */
  WORKBENCH_TERMINAL: z
    .string()
    .optional()
    .transform((v) => v === "true" || v === "1"),
});

export type AppConfig = z.infer<typeof envSchema> & {
  skipLabels: string[];
  mrReviewerUsernames: string[];
  mrAssigneeUsernames: string[];
  onCompleteAssignUsernames: string[];
  onCompleteLabels: string[];
  STARTUP_SCAN: boolean;
  STARTUP_SCAN_INCLUDE_SUCCEEDED: boolean;
  WORKBENCH_TERMINAL: boolean;
  isProd: boolean;
  corsOrigins: string[];
  rateLimitWindowMs: number;
  rateLimitMax: number;
  googleOAuthConfigured: boolean;
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

  const isProd =
    (env.NODE_ENV || process.env.NODE_ENV || "").toLowerCase() === "production";

  const defaultCors = [
    "http://127.0.0.1:5173",
    "http://localhost:5173",
    "http://127.0.0.1:8787",
    "http://localhost:8787",
  ];
  const corsOrigins = (env.CORS_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const resolvedCors = corsOrigins.length > 0 ? corsOrigins : defaultCors;

  const googleClientId = (env.GOOGLE_OAUTH_CLIENT_ID ?? "").trim();
  const googleClientSecret = (env.GOOGLE_OAUTH_CLIENT_SECRET ?? "").trim();
  const googleRedirect = (env.GOOGLE_OAUTH_REDIRECT_URI ?? "").trim();

  cached = {
    ...env,
    skipLabels: env.SKIP_LABELS.split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    mrReviewerUsernames: (env.MR_REVIEWER_USERNAMES ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    mrAssigneeUsernames: (() => {
      const assignees = (env.MR_ASSIGNEE_USERNAMES ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (assignees.length) return assignees;
      const reviewers = (env.MR_REVIEWER_USERNAMES ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (reviewers.length) return reviewers;
      return ["anhvh4"];
    })(),
    onCompleteAssignUsernames: (env.ON_COMPLETE_ASSIGN_USERNAMES ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    onCompleteLabels: (env.ON_COMPLETE_LABELS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    isProd,
    WORKBENCH_TERMINAL: Boolean(env.WORKBENCH_TERMINAL),
    corsOrigins: resolvedCors,
    rateLimitWindowMs: env.RATE_LIMIT_WINDOW_MS ?? 15 * 60 * 1000,
    rateLimitMax: env.RATE_LIMIT_MAX ?? 0, //1000,
    googleOAuthConfigured: Boolean(
      googleClientId && googleClientSecret && googleRedirect,
    ),
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
