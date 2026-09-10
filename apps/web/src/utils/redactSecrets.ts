/**
 * Strip credentials / PATs from text before showing in /work UI.
 * Defense in depth — API should already redact; never display raw keys.
 */
export function redactSecrets(text: string): string {
  return String(text || "")
    .replace(/oauth2:[^@\s]+@/gi, "oauth2:***@")
    .replace(/x-access-token:[^@\s]+@/gi, "x-access-token:***@")
    .replace(/(https?:\/\/)([^/\s:@]+):([^@/\s]+)@/gi, "$1$2:***@")
    .replace(/\bgithub_pat_[A-Za-z0-9_]+/g, "github_pat_***")
    .replace(/\bghp_[A-Za-z0-9_]+/g, "ghp_***")
    .replace(/\bglpat-[A-Za-z0-9_-]+/g, "glpat-***")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer ***")
    .replace(/\bsk-[A-Za-z0-9]{20,}/g, "sk-***");
}
