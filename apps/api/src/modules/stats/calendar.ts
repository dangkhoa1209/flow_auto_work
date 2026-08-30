export const STATS_TZ = "Asia/Ho_Chi_Minh";

export function dayKeyFromIso(iso?: string, tz = STATS_TZ): string | null {
  if (!iso) return null;
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(iso));
  } catch {
    return iso.slice(0, 10);
  }
}

export function formatYmdUtc(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function isoWeekFromYmd(ymd: string): {
  weekKey: string;
  week: number;
  isoYear: number;
  weekStart: string;
  weekEnd: string;
  weekLabel: string;
} {
  const [Y, M, D] = ymd.split("-").map(Number);
  const utc = new Date(Date.UTC(Y, M - 1, D));
  const dayNum = utc.getUTCDay() || 7;
  const thursday = new Date(utc);
  thursday.setUTCDate(utc.getUTCDate() + 4 - dayNum);
  const isoYear = thursday.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 1));
  const week = Math.ceil(
    ((thursday.getTime() - yearStart.getTime()) / 86400000 + 1) / 7,
  );
  const weekStart = new Date(utc);
  weekStart.setUTCDate(utc.getUTCDate() - (dayNum - 1));
  const weekEnd = new Date(weekStart);
  weekEnd.setUTCDate(weekStart.getUTCDate() + 6);
  const weekKey = `${isoYear}-W${String(week).padStart(2, "0")}`;
  const ws = formatYmdUtc(weekStart);
  const we = formatYmdUtc(weekEnd);
  return {
    weekKey,
    week,
    isoYear,
    weekStart: ws,
    weekEnd: we,
    weekLabel: `Week ${week} · ${ws.slice(5).replace("-", "/")}–${we.slice(5).replace("-", "/")}`,
  };
}

export function monthLabel(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    year: "numeric",
  }).format(new Date(y, m - 1, 1));
}

export function monthShortLabel(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    year: "numeric",
  }).format(new Date(y, m - 1, 1));
}

/** Inclusive YYYY-MM-DD range in STATS_TZ, most recent last. */
export function enumerateDays(fromYmd: string, toYmd: string): string[] {
  const days: string[] = [];
  const [fy, fm, fd] = fromYmd.split("-").map(Number);
  const [ty, tm, td] = toYmd.split("-").map(Number);
  const cur = new Date(Date.UTC(fy, fm - 1, fd));
  const end = new Date(Date.UTC(ty, tm - 1, td));
  while (cur.getTime() <= end.getTime()) {
    days.push(formatYmdUtc(cur));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return days;
}

export function shiftYmd(ymd: string, deltaDays: number): string {
  const [Y, M, D] = ymd.split("-").map(Number);
  const utc = new Date(Date.UTC(Y, M - 1, D));
  utc.setUTCDate(utc.getUTCDate() + deltaDays);
  return formatYmdUtc(utc);
}
