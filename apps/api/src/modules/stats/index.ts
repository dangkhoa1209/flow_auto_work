import { getConfig } from "../../config.js";
import { aggregateJobsForStats } from "../../db/mongo.js";
import { getRuntimeContext } from "../../workspace/runtime.js";
import { enumerateDays, shiftYmd, STATS_TZ } from "./calendar.js";
import { classifyFailReason, estimateUsd, pctChange, successRate } from "./metrics.js";
import { buildMonthTree, finishDayBucket } from "./tree.js";
import type {
  FailReasonRow,
  InsightJob,
  PeriodCompare,
  ProjectTokens,
  StatsDayItem,
} from "./types.js";

export type GetDailyStatsQuery = {
  days?: number;
  from?: string;
  to?: string;
  status?: string;
  workspaceProjectId?: string;
  ownerUsername?: string;
  allOwners?: boolean;
  allProjects?: boolean;
  q?: string;
};

const RUNNING_LIKE = new Set([
  "queued",
  "running",
  "awaiting_clarification",
  "draft",
  "awaiting_docs_approval",
  "awaiting_google_auth",
  "awaiting_figma_auth",
  "awaiting_diff_approval",
]);

function parseYmd(s: string | undefined): string | null {
  if (!s) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

/** ICT is UTC+7 year-round. */
function ymdToUtcRange(ymd: string, endOfDay: boolean): Date {
  const [Y, M, D] = ymd.split("-").map(Number);
  if (!endOfDay) {
    return new Date(Date.UTC(Y, M - 1, D) - 7 * 3600_000);
  }
  return new Date(Date.UTC(Y, M - 1, D, 16, 59, 59, 999));
}

function windowYmd(
  daysRaw: number,
  from?: string,
  to?: string,
): { days: number; fromYmd: string; toYmd: string } {
  const days = Math.min(365, Math.max(1, Number(daysRaw || 90)));
  const toYmd =
    parseYmd(to) ||
    new Intl.DateTimeFormat("en-CA", {
      timeZone: STATS_TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
  const fromParsed = parseYmd(from);
  const fromYmd = fromParsed || shiftYmd(toYmd, -(days - 1));
  const span =
    (Date.parse(`${toYmd}T00:00:00Z`) - Date.parse(`${fromYmd}T00:00:00Z`)) /
      86400000 +
    1;
  return {
    days: Math.min(365, Math.max(1, Math.round(span))),
    fromYmd,
    toYmd,
  };
}

function toItem(row: {
  dayKey: string;
  jobId: string;
  status: string;
  issueIid: number;
  title: string;
  url: string;
  at: string;
  summary?: string;
  error?: string;
  workspaceProjectId?: string;
  ownerUsername?: string;
  tokensTotal: number;
  tokensInput: number;
  tokensOutput: number;
  durationMs: number | null;
}): StatsDayItem {
  return {
    jobId: String(row.jobId),
    status: row.status,
    issueIid: row.issueIid,
    title: row.title,
    url: row.url,
    at: row.at,
    summary: row.summary,
    error: row.error || undefined,
    workspaceProjectId: row.workspaceProjectId,
    ownerUsername: row.ownerUsername,
    tokensTotal: row.tokensTotal || 0,
    tokensInput: row.tokensInput || 0,
    tokensOutput: row.tokensOutput || 0,
    durationMs:
      row.durationMs != null && row.durationMs > 0 ? row.durationMs : null,
  };
}

function toInsight(row: Parameters<typeof toItem>[0]): InsightJob {
  const item = toItem(row);
  return {
    jobId: item.jobId,
    issueIid: item.issueIid,
    title: item.title,
    url: item.url,
    status: item.status,
    tokensTotal: item.tokensTotal,
    durationMs: item.durationMs,
    date: row.dayKey,
  };
}

export async function getDailyStats(query: GetDailyStatsQuery | number = 90) {
  const q =
    typeof query === "number"
      ? ({ days: query } satisfies GetDailyStatsQuery)
      : query;
  const rt = getRuntimeContext();
  const { days, fromYmd, toYmd } = windowYmd(q.days ?? 90, q.from, q.to);
  const statuses = (q.status || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const workspaceProjectId = q.allProjects
    ? undefined
    : q.workspaceProjectId || rt?.projectId;
  const ownerUsername = q.allOwners
    ? undefined
    : q.ownerUsername || rt?.gitlabUsername;

  const rangeStart = ymdToUtcRange(fromYmd, false);
  const rangeEnd = ymdToUtcRange(toYmd, true);

  const prevTo = shiftYmd(fromYmd, -1);
  const prevFrom = shiftYmd(prevTo, -(days - 1));
  const prevStart = ymdToUtcRange(prevFrom, false);
  const prevEnd = ymdToUtcRange(prevTo, true);

  const baseFilter = {
    workspaceProjectId,
    ownerUsername,
    statuses: statuses.length ? statuses : undefined,
    q: q.q,
  };

  const [current, previous] = await Promise.all([
    aggregateJobsForStats({
      ...baseFilter,
      rangeStart,
      rangeEnd,
    }),
    aggregateJobsForStats({
      ...baseFilter,
      rangeStart: prevStart,
      rangeEnd: prevEnd,
    }),
  ]);

  const byDay = new Map<
    string,
    {
      date: string;
      jobCount: number;
      awaitingHandoff: number;
      succeeded: number;
      failed: number;
      runningLike: number;
      tokensTotal: number;
      tokensInput: number;
      tokensOutput: number;
      items: StatsDayItem[];
    }
  >();

  const ensure = (d: string) => {
    let b = byDay.get(d);
    if (!b) {
      b = {
        date: d,
        jobCount: 0,
        awaitingHandoff: 0,
        succeeded: 0,
        failed: 0,
        runningLike: 0,
        tokensTotal: 0,
        tokensInput: 0,
        tokensOutput: 0,
        items: [],
      };
      byDay.set(d, b);
    }
    return b;
  };

  const tokensByProject = new Map<string, ProjectTokens>();
  const failMap = new Map<string, number>();
  const tokensTotal = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    jobs: 0,
  };

  for (const raw of current.rows) {
    const item = toItem(raw);
    const bucket = ensure(raw.dayKey);
    bucket.jobCount += 1;
    bucket.tokensTotal += item.tokensTotal;
    bucket.tokensInput += item.tokensInput;
    bucket.tokensOutput += item.tokensOutput;
    if (item.tokensTotal) {
      tokensTotal.totalTokens += item.tokensTotal;
      tokensTotal.inputTokens += item.tokensInput;
      tokensTotal.outputTokens += item.tokensOutput;
      tokensTotal.jobs += 1;
      const pid = item.workspaceProjectId || "(no project)";
      let p = tokensByProject.get(pid);
      if (!p) {
        p = {
          workspaceProjectId: pid,
          jobs: 0,
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
        };
        tokensByProject.set(pid, p);
      }
      p.jobs += 1;
      p.inputTokens += item.tokensInput;
      p.outputTokens += item.tokensOutput;
      p.totalTokens += item.tokensTotal;
    }
    if (item.status === "awaiting_handoff") bucket.awaitingHandoff += 1;
    else if (item.status === "succeeded") bucket.succeeded += 1;
    else if (item.status === "failed") {
      bucket.failed += 1;
      const reason = classifyFailReason(item.error);
      failMap.set(reason, (failMap.get(reason) || 0) + 1);
    } else if (RUNNING_LIKE.has(item.status)) {
      bucket.runningLike += 1;
    }

    bucket.items.push(item);
  }

  const daily = [...byDay.values()]
    .map((b) => {
      b.items.sort((a, c) => (a.at < c.at ? 1 : -1));
      return finishDayBucket(b);
    })
    .sort((a, b) => (a.date < b.date ? 1 : -1));

  const months = buildMonthTree(daily);

  const prevJobs = previous.totalInRange;
  const prevTokens = previous.rows.reduce((s, r) => s + (r.tokensTotal || 0), 0);
  const prevSucceeded = previous.rows.filter((r) => r.status === "succeeded")
    .length;
  const prevFailed = previous.rows.filter((r) => r.status === "failed").length;
  const prevRate = successRate(prevSucceeded, prevFailed);
  const currRate = successRate(
    daily.reduce((s, d) => s + d.succeeded, 0),
    daily.reduce((s, d) => s + d.failed, 0),
  );

  const compare: PeriodCompare = {
    jobsPct: pctChange(daily.reduce((s, d) => s + d.jobCount, 0), prevJobs),
    tokensPct: pctChange(tokensTotal.totalTokens, prevTokens),
    successRateDelta:
      currRate != null && prevRate != null
        ? Math.round((currRate - prevRate) * 10) / 10
        : null,
    previousJobs: prevJobs,
    previousTokens: prevTokens,
  };

  const heatmap = enumerateDays(fromYmd, toYmd).map((date) => {
    const b = byDay.get(date);
    return {
      date,
      jobs: b?.jobCount ?? 0,
      tokens: b?.tokensTotal ?? 0,
    };
  });

  const insights = {
    topTokens: [...current.rows]
      .filter((r) => r.tokensTotal > 0)
      .sort((a, b) => b.tokensTotal - a.tokensTotal)
      .slice(0, 8)
      .map(toInsight),
    slowest: [...current.rows]
      .filter((r) => r.durationMs != null && r.durationMs > 0)
      .sort((a, b) => (b.durationMs || 0) - (a.durationMs || 0))
      .slice(0, 8)
      .map(toInsight),
  };

  const failReasons: FailReasonRow[] = [...failMap.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 12);

  const cfg = getConfig();
  const usdIn = cfg.STATS_USD_PER_MILLION_INPUT;
  const usdOut = cfg.STATS_USD_PER_MILLION_OUTPUT;
  const costUsd = estimateUsd(
    tokensTotal.inputTokens,
    tokensTotal.outputTokens,
    usdIn,
    usdOut,
  );

  const totalsBucket = finishDayBucket({
    date: `${fromYmd}…${toYmd}`,
    jobCount: daily.reduce((s, d) => s + d.jobCount, 0),
    awaitingHandoff: daily.reduce((s, d) => s + d.awaitingHandoff, 0),
    succeeded: daily.reduce((s, d) => s + d.succeeded, 0),
    failed: daily.reduce((s, d) => s + d.failed, 0),
    runningLike: daily.reduce((s, d) => s + d.runningLike, 0),
    tokensTotal: tokensTotal.totalTokens,
    tokensInput: tokensTotal.inputTokens,
    tokensOutput: tokensTotal.outputTokens,
    items: daily.flatMap((d) => d.items),
  });
  const { items: _totalsItems, ...totals } = totalsBucket;

  const pendingHandoff = current.rows
    .filter((j) => j.status === "awaiting_handoff")
    .map((j) => ({
      jobId: String(j.jobId),
      issueIid: j.issueIid,
      title: j.title,
      url: j.url,
      completedAt: j.at,
      summary: j.summary,
    }));

  return {
    timezone: STATS_TZ,
    days,
    from: fromYmd,
    to: toYmd,
    truncated: current.truncated,
    totalJobsInRange: current.totalInRange,
    returnedJobs: current.rows.length,
    pendingHandoffCount: pendingHandoff.length,
    pendingHandoff,
    totals: {
      ...totals,
      spark: heatmap.map((h) => h.jobs),
    },
    daily,
    months,
    tokens: {
      ...tokensTotal,
      byProject: [...tokensByProject.values()].sort(
        (a, b) => b.totalTokens - a.totalTokens,
      ),
    },
    compare,
    failReasons,
    heatmap,
    insights,
    cost: {
      usd: Math.round(costUsd * 10000) / 10000,
      usdPerMillionInput: usdIn,
      usdPerMillionOutput: usdOut,
    },
    filters: {
      owners: current.owners,
      projects: current.projects,
      workspaceProjectId: workspaceProjectId || null,
      ownerUsername: ownerUsername || null,
    },
  };
}
