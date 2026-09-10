/**
 * Strip credentials from git command/error text before logs or UI.
 * Node execFile prefixes failures with `Command failed: git … <url-with-token>`.
 * /work surfaces this via queue `Chat lỗi:` / `Run lỗi:` → must redact before chat.
 */
export function redactGitCredentials(text: string): string {
  return text
    .replace(/oauth2:[^@\s]+@/gi, "oauth2:***@")
    .replace(/x-access-token:[^@\s]+@/gi, "x-access-token:***@")
    .replace(/(https?:\/\/)([^/\s:@]+):([^@/\s]+)@/gi, "$1$2:***@")
    .replace(/\bgithub_pat_[A-Za-z0-9_]+/g, "github_pat_***")
    .replace(/\bghp_[A-Za-z0-9_]+/g, "ghp_***")
    .replace(/\bglpat-[A-Za-z0-9_-]+/g, "glpat-***")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer ***")
    .replace(/\bsk-[A-Za-z0-9]{20,}/g, "sk-***");
}

/** Safe string for job.error / chat — never leave PAT in UI. */
export function safeErrorMessage(err: unknown): string {
  const raw =
    err instanceof Error ? err.message : typeof err === "string" ? err : String(err);
  return redactGitCredentials(raw);
}

/** Mutate Error (+ execFile extras) so message/cmd/stderr never leak PATs. */
export function redactGitError(err: unknown): unknown {
  if (!(err instanceof Error)) return err;
  err.message = redactGitCredentials(err.message);
  const extra = err as Error & { cmd?: string; stderr?: string; stdout?: string };
  if (typeof extra.cmd === "string") {
    extra.cmd = redactGitCredentials(extra.cmd);
  }
  if (typeof extra.stderr === "string") {
    extra.stderr = redactGitCredentials(extra.stderr);
  }
  if (typeof extra.stdout === "string") {
    extra.stdout = redactGitCredentials(extra.stdout);
  }
  return err;
}
