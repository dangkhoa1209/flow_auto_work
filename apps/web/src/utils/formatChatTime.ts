/** Compact timestamp for chat bubbles (date + time). */
export function formatChatTime(iso: string | undefined | null): string {
  if (!iso?.trim()) return "";
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

/** Relative time for thread lists ("2m ago"). Falls back to compact date. */
export function formatRelativeTime(iso: string | undefined | null): string {
  if (!iso?.trim()) return "";
  try {
    const t = new Date(iso).getTime();
    if (!Number.isFinite(t)) return "";
    const sec = Math.round((Date.now() - t) / 1000);
    if (sec < 45) return "just now";
    if (sec < 3600) return `${Math.max(1, Math.floor(sec / 60))}m ago`;
    if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
    if (sec < 86400 * 7) return `${Math.floor(sec / 86400)}d ago`;
    return formatChatTime(iso);
  } catch {
    return "";
  }
}
