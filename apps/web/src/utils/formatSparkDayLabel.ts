/** Unique compact label for spark-chart day columns (14d window). */
export function formatSparkDayLabel(date: string): string {
  try {
    const d = new Date(`${date}T12:00:00`);
    if (!Number.isFinite(d.getTime())) return date.slice(8, 10);
    return new Intl.DateTimeFormat("en-GB", {
      day: "numeric",
      month: "numeric",
    }).format(d);
  } catch {
    const parts = date.split("-");
    if (parts.length >= 3) return `${Number(parts[2])}/${Number(parts[1])}`;
    return date.slice(-2);
  }
}
