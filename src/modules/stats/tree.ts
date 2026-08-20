import { isoWeekFromYmd, monthLabel } from "./calendar.js";
import { avg, median, successRate } from "./metrics.js";
import type {
  StatsCounts,
  StatsDayBucket,
  StatsMonthNode,
  StatsWeekNode,
} from "./types.js";

function withDerived(base: Omit<StatsCounts, "tokensAvgPerJob" | "successRate"> & {
  durationSamples: number[];
}): StatsCounts {
  return {
    jobCount: base.jobCount,
    awaitingHandoff: base.awaitingHandoff,
    succeeded: base.succeeded,
    failed: base.failed,
    runningLike: base.runningLike,
    tokensTotal: base.tokensTotal,
    tokensInput: base.tokensInput,
    tokensOutput: base.tokensOutput,
    tokensAvgPerJob: avg(base.tokensTotal, base.jobCount),
    successRate: successRate(base.succeeded, base.failed),
    durationAvgMs: avg(
      base.durationSamples.reduce((s, n) => s + n, 0),
      base.durationSamples.length,
    ),
    durationMedianMs: median(base.durationSamples),
  };
}

function emptyCounts(): Omit<StatsCounts, "tokensAvgPerJob" | "successRate"> & {
  durationSamples: number[];
} {
  return {
    jobCount: 0,
    awaitingHandoff: 0,
    succeeded: 0,
    failed: 0,
    runningLike: 0,
    tokensTotal: 0,
    tokensInput: 0,
    tokensOutput: 0,
    durationAvgMs: null,
    durationMedianMs: null,
    durationSamples: [],
  };
}

function samplesFromDay(day: StatsDayBucket): number[] {
  return day.items
    .map((it) => it.durationMs)
    .filter((n): n is number => n != null && n > 0);
}

function addDay(
  acc: ReturnType<typeof emptyCounts>,
  day: StatsDayBucket,
): void {
  acc.jobCount += day.jobCount;
  acc.awaitingHandoff += day.awaitingHandoff;
  acc.succeeded += day.succeeded;
  acc.failed += day.failed;
  acc.runningLike += day.runningLike;
  acc.tokensTotal += day.tokensTotal;
  acc.tokensInput += day.tokensInput;
  acc.tokensOutput += day.tokensOutput;
  acc.durationSamples.push(...samplesFromDay(day));
}

export function buildMonthTree(daily: StatsDayBucket[]): StatsMonthNode[] {
  const monthMap = new Map<string, StatsMonthNode>();
  for (const day of daily) {
    const monthKey = day.date.slice(0, 7);
    const week = isoWeekFromYmd(day.date);
    let month = monthMap.get(monthKey);
    if (!month) {
      month = {
        monthKey,
        label: monthLabel(monthKey),
        spark: [],
        weeks: [],
        ...withDerived(emptyCounts()),
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
        spark: [],
        days: [],
        ...withDerived(emptyCounts()),
      };
      month.weeks.push(weekNode);
    }
    weekNode.days.push(day);
  }

  const months = [...monthMap.values()].map((m) => {
    m.weeks.sort((a, b) => (a.weekStart < b.weekStart ? 1 : -1));
    for (const w of m.weeks) {
      w.days.sort((a, b) => (a.date < b.date ? 1 : -1));
      const wAcc = emptyCounts();
      for (const d of w.days) addDay(wAcc, d);
      Object.assign(w, withDerived(wAcc));
      w.spark = [...w.days]
        .slice()
        .reverse()
        .map((d) => d.jobCount || d.items.length);
    }
    const mAcc = emptyCounts();
    for (const w of m.weeks) {
      for (const d of w.days) addDay(mAcc, d);
    }
    Object.assign(m, withDerived(mAcc));
    m.spark = m.weeks
      .slice()
      .reverse()
      .flatMap((w) =>
        [...w.days].slice().reverse().map((d) => d.jobCount || d.items.length),
      );
    return m;
  });

  months.sort((a, b) => (a.monthKey < b.monthKey ? 1 : -1));
  return months;
}

export function finishDayBucket(partial: {
  date: string;
  jobCount: number;
  awaitingHandoff: number;
  succeeded: number;
  failed: number;
  runningLike: number;
  tokensTotal: number;
  tokensInput: number;
  tokensOutput: number;
  items: StatsDayBucket["items"];
}): StatsDayBucket {
  const samples = partial.items
    .map((it) => it.durationMs)
    .filter((n): n is number => n != null && n > 0);
  return {
    ...partial,
    ...withDerived({
      jobCount: partial.jobCount,
      awaitingHandoff: partial.awaitingHandoff,
      succeeded: partial.succeeded,
      failed: partial.failed,
      runningLike: partial.runningLike,
      tokensTotal: partial.tokensTotal,
      tokensInput: partial.tokensInput,
      tokensOutput: partial.tokensOutput,
      durationAvgMs: null,
      durationMedianMs: null,
      durationSamples: samples,
    }),
    spark: [partial.jobCount || partial.items.length],
  };
}
