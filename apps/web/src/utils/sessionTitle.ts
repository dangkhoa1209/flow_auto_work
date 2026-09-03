/** First-line title for a chat-started Work session (no GitLab issue yet). */
export function titleFromWorkRequest(raw: string, max = 72): string {
  const first =
    String(raw || "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find(Boolean) || "";
  const s = first.replace(/\s+/g, " ");
  if (!s) return "Session";
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(1, max - 1))}…`;
}
