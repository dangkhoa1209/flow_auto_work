import { AsyncLocalStorage } from "node:async_hooks";

import type { GitProvider } from "./types.js";

/**
 * Per-request / per-job runtime credentials.
 * Tokens are decrypted in memory only — never logged.
 */
export type RuntimeContext = {
  gitlabUsername: string;
  gitlabToken: string;
  /** Optional until agent Run */
  cursorApiKey?: string;
  /** Cursor model id — auto or concrete */
  cursorModel?: string;
  projectId: string;
  /** gitlab | github — default gitlab */
  gitProvider: GitProvider;
  /** Remote host (gitlab.com / github.com / …) */
  gitlabHost: string;
  gitlabPath: string;
  gitlabProjectId?: number;
  repoPath: string;
  /** Project / base branch (fork point for auto feat branches) */
  baseBranch?: string;
  /** Fixed work branch; empty → auto feat/<iid>/slug per task */
  workBranch?: string;
  /** Per-project verify command (typecheck/lint/build) — overrides VERIFY_COMMAND env */
  verifyCommand?: string;
};

const als = new AsyncLocalStorage<RuntimeContext>();

export function runWithRuntimeContext<T>(
  ctx: RuntimeContext,
  fn: () => Promise<T> | T,
): Promise<T> | T {
  return als.run(ctx, fn);
}

export function getRuntimeContext(): RuntimeContext | undefined {
  return als.getStore();
}

export function requireRuntimeContext(): RuntimeContext {
  const ctx = als.getStore();
  if (!ctx) {
    throw new Error(
      "No workspace runtime context — login + select project first",
    );
  }
  return ctx;
}
