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
