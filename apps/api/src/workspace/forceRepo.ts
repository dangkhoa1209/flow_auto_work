import { AsyncLocalStorage } from "node:async_hooks";

/** Per-async-job override for ephemeral worktree cwd (safe under worker concurrency). */
const forceRepoAls = new AsyncLocalStorage<string>();

export function runWithForcedRepoPath<T>(
  repoPath: string,
  fn: () => Promise<T> | T,
): Promise<T> | T {
  return forceRepoAls.run(repoPath, fn);
}

export function getForcedRepoPath(): string | undefined {
  return forceRepoAls.getStore()?.trim() || undefined;
}
