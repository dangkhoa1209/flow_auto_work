import {
  aggregateJobsForDevAnalysis,
  type DevAnalysisJobRow,
} from "../../models/jobStats.js";
import { getRuntimeContext } from "../../workspace/runtime.js";
import { shiftYmd, STATS_TZ } from "./calendar.js";
import { classifyFailReason } from "./metrics.js";
import { workDurationMs } from "./workHours.js";
import {
  computeDimensions,
  dimensionTrend,
  type AnalysisJob,
  type SkillDimensions,
} from "./scoring.js";
import { classifyTaskType, TASK_TYPE_LABELS, type TaskType } from "./taskType.js";
import { getTaskTypeLabelMapping } from "../../workspace/baStore.js";
import {
  getCachedDevAnalysis,
  saveDevAnalysisCache,
} from "./analysisCache.js";
import {
  analyzeWithCursorSdk,
  DEV_ANALYSIS_ENGINE,
} from "./llmAnalyze.js";
import type { GetDailyStatsQuery } from "./index.js";

export type DevRecommendation = {
  id: string;
  dimension: keyof SkillDimensions;
  severity: "high" | "medium" | "low";
  text: string;
  evidenceJobs: Array<{
    jobId: string;
    issueIid: number;
    title: string;
    url: string;
  }>;
};

export type TaskTypeStats = {
  taskType: TaskType;
  label: string;
  count: number;
  succeeded: number;
  failed: number;
  failRate: number | null;
  avgDurationMs: number | null;
  avgTokens: number | null;
};

export type DevAnalysisResult = {
  analyzedAt: string;
  from: string;
  to: string;
  ownerUsername: string;
  workspaceProjectId: string | null;
  jobCount: number;
  truncated: boolean;
  cached: boolean;
  dimensions: SkillDimensions;
  previousDimensions?: SkillDimensions;
  trend?: Record<keyof SkillDimensions, number | null>;
  byTaskType: TaskTypeStats[];
  recommendations: DevRecommendation[];
  narrative?: string;
  engine?: string;
  dataGaps: string[];
};

function parseYmd(s: string | undefined): string | null {
  if (!s) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

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

function rowToAnalysisJob(
  row: DevAnalysisJobRow,
  labelMapping: Parameters<typeof classifyTaskType>[2],
): AnalysisJob {
  const taskType = classifyTaskType(row.title, row.labels || [], labelMapping);
  const workMs = workDurationMs(row.createdAt, row.completedAt);
  return {
    jobId: String(row.jobId),
    issueIid: row.issueIid,
    title: row.title,
    url: row.url,
    status: row.status,
    durationMs: row.durationMs,
    workDurationMs: workMs,
    tokensTotal: row.tokensTotal || 0,
    runCount: row.runCount || 0,
    taskType,
    failReason:
      row.status === "failed" ? classifyFailReason(row.error) : undefined,
  };
}

function buildTaskTypeStats(jobs: AnalysisJob[]): TaskTypeStats[] {
  const map = new Map<TaskType, AnalysisJob[]>();
  for (const j of jobs) {
    const t = (j.taskType || "other") as TaskType;
    const arr = map.get(t) || [];
    arr.push(j);
    map.set(t, arr);
  }
  return [...map.entries()]
    .map(([taskType, list]) => {
      const terminal = list.filter((j) =>
        ["succeeded", "failed"].includes(j.status),
      );
      const succeeded = list.filter((j) => j.status === "succeeded");
      const failed = list.filter((j) => j.status === "failed");
      const durs = succeeded
        .map((j) => j.workDurationMs ?? j.durationMs)
        .filter((n): n is number => n != null && n > 0);
      const toks = succeeded.map((j) => j.tokensTotal).filter((n) => n > 0);
      return {
        taskType,
        label: TASK_TYPE_LABELS[taskType],
        count: list.length,
        succeeded: succeeded.length,
        failed: failed.length,
        failRate:
          succeeded.length + failed.length > 0
            ? Math.round(
                (failed.length / (succeeded.length + failed.length)) * 1000,
              ) / 10
            : null,
        avgDurationMs:
          durs.length > 0
            ? Math.round(durs.reduce((s, n) => s + n, 0) / durs.length)
            : null,
        avgTokens:
          toks.length > 0
            ? Math.round(toks.reduce((s, n) => s + n, 0) / toks.length)
            : null,
      };
    })
    .sort((a, b) => b.count - a.count);
}

async function loadJobsForWindow(
  q: GetDailyStatsQuery,
  fromYmd: string,
  toYmd: string,
): Promise<Awaited<ReturnType<typeof aggregateJobsForDevAnalysis>>> {
  const rt = getRuntimeContext();
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

  return aggregateJobsForDevAnalysis({
    workspaceProjectId,
    ownerUsername,
    statuses: statuses.length ? statuses : undefined,
    q: q.q,
    rangeStart: ymdToUtcRange(fromYmd, false),
    rangeEnd: ymdToUtcRange(toYmd, true),
  });
}

export async function analyzeDevPerformance(
  query: GetDailyStatsQuery,
  opts?: { force?: boolean },
): Promise<DevAnalysisResult> {
  const rt = getRuntimeContext();
  const ownerUsername = query.ownerUsername || rt?.gitlabUsername || "";
  const workspaceProjectId = query.allProjects
    ? null
    : query.workspaceProjectId || rt?.projectId || null;

  const { days, fromYmd, toYmd } = windowYmd(
    query.days ?? 90,
    query.from,
    query.to,
  );

  const current = await loadJobsForWindow(query, fromYmd, toYmd);
  const { labels: labelMapping, updatedAt: labelConfigAt } =
    await getTaskTypeLabelMapping();
  const jobs = current.rows.map((r) => rowToAnalysisJob(r, labelMapping));

  if (!opts?.force) {
    const cached = await getCachedDevAnalysis({
      ownerUsername,
      workspaceProjectId,
      from: fromYmd,
      to: toYmd,
      jobCount: current.totalInRange,
      labelConfigAt,
      engine: DEV_ANALYSIS_ENGINE,
    });
    if (cached) return cached;
  }

  const formulaDimensions = computeDimensions(jobs);
  const byTaskType = buildTaskTypeStats(jobs);

  const prevTo = shiftYmd(fromYmd, -1);
  const prevFrom = shiftYmd(prevTo, -(days - 1));
  const previous = await loadJobsForWindow(query, prevFrom, prevTo);
  const prevJobs = previous.rows.map((r) => rowToAnalysisJob(r, labelMapping));
  const previousDimensions = computeDimensions(prevJobs);

  const llm = jobs.length
    ? await analyzeWithCursorSdk({
        ownerUsername,
        from: fromYmd,
        to: toYmd,
        dimensions: formulaDimensions,
        previousDimensions,
        trend: dimensionTrend(formulaDimensions, previousDimensions),
        byTaskType,
        jobs,
      })
    : {
        narrative: "Không có task trong khoảng đang xem — chưa đủ dữ liệu để đánh giá.",
        recommendations: [] as DevAnalysisResult["recommendations"],
        dimensions: undefined as SkillDimensions | undefined,
      };

  const dimensions = llm.dimensions ?? formulaDimensions;
  const trend = dimensionTrend(dimensions, previousDimensions);

  const dataGaps: string[] = [];
  if (current.truncated) {
    dataGaps.push("Dữ liệu bị cắt ở 10k job — chỉ số có thể lệch.");
  }
  dataGaps.push(
    "Thời gian làm việc: T2–T7 08:30–17:30 (Asia/Ho_Chi_Minh); Chủ nhật không tính. Điểm 5 trục do agent chấm, có xét độ khó task.",
  );
  dataGaps.push(
    "Chưa có CI/review/diff size trong DB — agent dựa trên status, thời gian làm việc, token, labels GitLab.",
  );
  if (jobs.every((j) => !j.tokensTotal)) {
    dataGaps.push("Thiếu token usage trên nhiều job — trụ hiệu quả có thể không chính xác.");
  }
  if (!llm.dimensions && jobs.length) {
    dataGaps.push("Agent không trả điểm — đang dùng điểm công thức tạm.");
  }

  const result: DevAnalysisResult = {
    analyzedAt: new Date().toISOString(),
    from: fromYmd,
    to: toYmd,
    ownerUsername,
    workspaceProjectId,
    jobCount: current.totalInRange,
    truncated: current.truncated,
    cached: false,
    dimensions,
    previousDimensions,
    trend,
    byTaskType,
    recommendations: llm.recommendations,
    narrative: llm.narrative,
    engine: DEV_ANALYSIS_ENGINE,
    dataGaps,
  };

  await saveDevAnalysisCache({
    ownerUsername,
    workspaceProjectId,
    from: fromYmd,
    to: toYmd,
    jobCount: current.totalInRange,
    labelConfigAt,
    engine: DEV_ANALYSIS_ENGINE,
    result,
  });

  return result;
}
