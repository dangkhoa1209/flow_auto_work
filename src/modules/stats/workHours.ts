import { STATS_TZ } from "./calendar.js";

/** Mon–Sat 08:30–17:30 in Asia/Ho_Chi_Minh (no DST). Sunday is off. */
export const WORK_TZ_OFFSET_MS = 7 * 3_600_000;
export const WORK_START_MIN = 8 * 60 + 30;
export const WORK_END_MIN = 17 * 60 + 30;

function vnShifted(utcMs: number): Date {
  return new Date(utcMs + WORK_TZ_OFFSET_MS);
}

function vnMidnightMs(utcMs: number): number {
  const vn = vnShifted(utcMs);
  return Date.UTC(
    vn.getUTCFullYear(),
    vn.getUTCMonth(),
    vn.getUTCDate(),
  );
}

/**
 * Elapsed working time between two instants, excluding nights and Sundays.
 * Saturday is a work day.
 */
export function workDurationMs(
  startIso?: string | null,
  endIso?: string | null,
): number | null {
  if (!startIso || !endIso) return null;
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return null;
  }

  let totalMin = 0;
  const startVn = start + WORK_TZ_OFFSET_MS;
  const endVn = end + WORK_TZ_OFFSET_MS;
  let dayMidnight = vnMidnightMs(start);

  while (dayMidnight < endVn) {
    const dow = new Date(dayMidnight).getUTCDay();
    if (dow !== 0) {
      const winStart = dayMidnight + WORK_START_MIN * 60_000;
      const winEnd = dayMidnight + WORK_END_MIN * 60_000;
      const a = Math.max(startVn, winStart);
      const b = Math.min(endVn, winEnd);
      if (b > a) totalMin += (b - a) / 60_000;
    }
    dayMidnight += 86_400_000;
  }

  return Math.round(totalMin * 60_000);
}

export function formatWorkHoursNote(): string {
  return `${STATS_TZ} Mon–Sat 08:30–17:30 (Sunday excluded)`;
}
