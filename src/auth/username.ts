const LEGACY_USERNAME_RE = /^[a-zA-Z0-9._-]{3,32}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Trim and strip a leading @ (GitLab-style handle), keep email intact. */
export function normalizeAuthUsername(raw: string): string {
  return raw.trim().replace(/^@+/, "");
}

export function isValidAuthUsername(raw: string): boolean {
  const username = normalizeAuthUsername(raw);
  if (!username) return false;
  if (LEGACY_USERNAME_RE.test(username)) return true;
  if (username.length <= 254 && EMAIL_RE.test(username)) return true;
  return false;
}

export const AUTH_USERNAME_HINT =
  "Username (3–32: letters, numbers, dot, underscore, hyphen) or email address";
