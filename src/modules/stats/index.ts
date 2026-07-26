import { listJobDocs } from "../../db/mongo.js";

/** Todolist / stats: only days with tasks, nested month → week → day (Asia/Ho_Chi_Minh). */
export async function getDailyStats(daysRaw?: number) {
  const days = Math.min(365, Math.max(1, Number(daysRaw ?? 90)));
  const jobs = await listJobDocs({ limit: 500 });
  const tz = "Asia/Ho_Chi_Minh";
  const dayKey = (iso?: string) => {
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
  };

  const formatYmdUtc = (d: Date) => {
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  };

  const isoWeekFromYmd = (ymd: string) => {
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
      weekLabel: `Tuần ${week} · ${ws.slice(5).replace("-", "/")}–${we.slice(5).replace("-", "/")}`,
    };
  };

  const monthLabel = (ym: string) => {
    const [y, m] = ym.split("-").map(Number);
    return `Tháng ${m}/${y}`;
  };

  type DayItem = {
    jobId: string;
    status: string;
    issueIid: number;
    title: string;
    url: string;
    at: string;
    summary?: string;
  };
  type DayBucket = {
    date: string;
    awaitingHandoff: number;
    succeeded: number;
    failed: number;
    runningLike: number;
    items: DayItem[];
  };
  const byDay = new Map<string, DayBucket>();

  const ensure = (d: string): DayBucket => {
    let b = byDay.get(d);
    if (!b) {
      b = {
        date: d,
        awaitingHandoff: 0,
        succeeded: 0,
        failed: 0,
        runningLike: 0,
        items: [],
      };
      byDay.set(d, b);
    }
    return b;
  };

  const windowStart = new Date();
  windowStart.setTime(windowStart.getTime() - (days - 1) * 86400000);
  const windowStartKey = dayKey(windowStart.toISOString())!;

  for (const job of jobs) {
    const at =
      job.completedAt || job.handedOffAt || job.updatedAt || job.createdAt;
    const key = dayKey(at);
    if (!key || key < windowStartKey) continue;

    const bucket = ensure(key);
    if (job.status === "awaiting_handoff") bucket.awaitingHandoff += 1;
    else if (job.status === "succeeded") bucket.succeeded += 1;
    else if (job.status === "failed") bucket.failed += 1;
    else if (
      job.status === "queued" ||
      job.status === "running" ||
      job.status === "awaiting_clarification" ||
      job.status === "draft"
    ) {
      bucket.runningLike += 1;
    }

    if (
      job.status === "awaiting_handoff" ||
      job.status === "succeeded" ||
      job.status === "failed"
    ) {
      bucket.items.push({
        jobId: job.id,
        status: job.status,
        issueIid: job.issue.issueIid,
        title: job.issue.title,
        url: job.issue.url,
        at,
        summary: job.summary,
      });
    }
  }

  const daily = [...byDay.values()]
    .filter((b) => b.items.length > 0)
    .map((b) => {
      b.items.sort((a, c) => (a.at < c.at ? 1 : -1));
      return b;
    })
    .sort((a, b) => (a.date < b.date ? 1 : -1));

  type WeekNode = {
    weekKey: string;
    label: string;
    weekStart: string;
    weekEnd: string;
    awaitingHandoff: number;
    succeeded: number;
    failed: number;
    days: DayBucket[];
  };
  type MonthNode = {
    monthKey: string;
    label: string;
    awaitingHandoff: number;
    succeeded: number;
    failed: number;
    weeks: WeekNode[];
  };

  const monthMap = new Map<string, MonthNode>();
  for (const day of daily) {
    const monthKey = day.date.slice(0, 7);
    const week = isoWeekFromYmd(day.date);
    let month = monthMap.get(monthKey);
    if (!month) {
      month = {
        monthKey,
        label: monthLabel(monthKey),
        awaitingHandoff: 0,
        succeeded: 0,
        failed: 0,
        weeks: [],
      };
      monthMap.set(monthKey, month);
    }
    let weekNode = month.weeks.find((w) => w.weekKey === week.weekKey);
    if (!weekNode) {
      weekNode = {
        weekKey: week.weekKey,
        label: week.weekLabel,
        weekStart: week.weekStart,
        weekEnd: week.weekEnd,
        awaitingHandoff: 0,
        succeeded: 0,
        failed: 0,
        days: [],
      };
      month.weeks.push(weekNode);
    }
    weekNode.days.push(day);
    weekNode.awaitingHandoff += day.awaitingHandoff;
    weekNode.succeeded += day.succeeded;
    weekNode.failed += day.failed;
    month.awaitingHandoff += day.awaitingHandoff;
    month.succeeded += day.succeeded;
    month.failed += day.failed;
  }

  const months = [...monthMap.values()]
    .map((m) => {
      m.weeks.sort((a, b) => (a.weekStart < b.weekStart ? 1 : -1));
      for (const w of m.weeks) {
        w.days.sort((a, b) => (a.date < b.date ? 1 : -1));
      }
      return m;
    })
    .sort((a, b) => (a.monthKey < b.monthKey ? 1 : -1));

  const pendingHandoff = jobs.filter((j) => j.status === "awaiting_handoff");

  return {
    timezone: tz,
    days,
    pendingHandoffCount: pendingHandoff.length,
    pendingHandoff: pendingHandoff.map((j) => ({
      jobId: j.id,
      issueIid: j.issue.issueIid,
      title: j.issue.title,
      url: j.issue.url,
      branch: j.branch,
      completedAt: j.completedAt,
      summary: j.summary,
    })),
    daily,
    months,
  };
}
