import {
  aggregateJobsForDevAnalysis,
  type DevAnalysisJobRow,
} from "../../db/mongo.js";
import { getRuntimeContext } from "../../workspace/runtime.js";
import { shiftYmd, STATS_TZ } from "./calendar.js";
import {
  classifyFailReason,
  successRate,
} from "./metrics.js";
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
  return {
    jobId: String(row.jobId),
    issueIid: row.issueIid,
    title: row.title,
    url: row.url,
    status: row.status,
    durationMs: row.durationMs,
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
        .map((j) => j.durationMs)
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

function buildRecommendations(
  jobs: AnalysisJob[],
  dimensions: SkillDimensions,
  byTaskType: TaskTypeStats[],
): DevRecommendation[] {
  const out: DevRecommendation[] = [];
  const terminal = jobs.filter((j) =>
    ["succeeded", "failed"].includes(j.status),
  );
  const overallFail =
    terminal.length > 0
      ? jobs.filter((j) => j.status === "failed").length / terminal.length
      : 0;

  for (const t of byTaskType) {
    if (t.count < 2 || t.failRate == null) continue;
    const fr = t.failRate / 100;
    if (fr > overallFail + 0.15 && fr >= 0.25) {
      const evidence = jobs
        .filter((j) => j.taskType === t.taskType && j.status === "failed")
        .slice(0, 3)
        .map((j) => ({
          jobId: j.jobId,
          issueIid: j.issueIid,
          title: j.title,
          url: j.url,
        }));
      out.push({
        id: `type-fail-${t.taskType}`,
        dimension: "scope",
        severity: fr >= 0.4 ? "high" : "medium",
        text: `Task loại ${t.label} có tỷ lệ fail ${Math.round(t.failRate)}% (cao hơn trung bình ${Math.round(overallFail * 100)}%) — nên xem lại cách tiếp cận ở nhóm task này.`,
        evidenceJobs: evidence,
      });
    }
  }

  if (dimensions.accuracy < 70 && terminal.length >= 3) {
    out.push({
      id: "low-accuracy",
      dimension: "accuracy",
      severity: dimensions.accuracy < 50 ? "high" : "medium",
      text: `Tỷ lệ hoàn thành thấp (${dimensions.accuracy}%) — kiểm tra lại Dev Notes, test local trước Run, và pattern lỗi lặp lại.`,
      evidenceJobs: jobs
        .filter((j) => j.status === "failed")
        .slice(0, 3)
        .map((j) => ({
          jobId: j.jobId,
          issueIid: j.issueIid,
          title: j.title,
          url: j.url,
        })),
    });
  }

  if (dimensions.consistency < 55 && jobs.filter((j) => j.status === "succeeded").length >= 4) {
    out.push({
      id: "low-consistency",
      dimension: "consistency",
      severity: "medium",
      text: `Thời gian xử lý biến động lớn giữa các task — thử chuẩn hóa quy trình (Dev Notes, scope rõ, chia nhỏ task).`,
      evidenceJobs: [],
    });
  }

  const highRetry = jobs.filter((j) => j.runCount >= 3 && j.status === "failed");
  if (highRetry.length >= 2) {
    out.push({
      id: "high-retry",
      dimension: "accuracy",
      severity: "medium",
      text: `${highRetry.length} task fail sau ≥3 lần Run — cân nhắc clarify sớm hoặc chia nhỏ scope trước khi chạy lại agent.`,
      evidenceJobs: highRetry.slice(0, 3).map((j) => ({
        jobId: j.jobId,
        issueIid: j.issueIid,
        title: j.title,
        url: j.url,
      })),
    });
  }

  const reasonMap = new Map<string, AnalysisJob[]>();
  for (const j of jobs.filter((j) => j.status === "failed" && j.failReason)) {
    const r = j.failReason!;
    const arr = reasonMap.get(r) || [];
    arr.push(j);
    reasonMap.set(r, arr);
  }
  const topReason = [...reasonMap.entries()].sort(
    (a, b) => b[1].length - a[1].length,
  )[0];
  if (topReason && topReason[1].length >= 2) {
    out.push({
      id: "top-fail-reason",
      dimension: "accuracy",
      severity: topReason[1].length >= 4 ? "high" : "low",
      text: `Lý do fail phổ biến: "${topReason[0]}" (${topReason[1].length} task) — ưu tiên xử lý root cause này.`,
      evidenceJobs: topReason[1].slice(0, 3).map((j) => ({
        jobId: j.jobId,
        issueIid: j.issueIid,
        title: j.title,
        url: j.url,
      })),
    });
  }

  return out.slice(0, 5);
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
    });
    if (cached) return cached;
  }

  const dimensions = computeDimensions(jobs);
  const byTaskType = buildTaskTypeStats(jobs);

  const prevTo = shiftYmd(fromYmd, -1);
  const prevFrom = shiftYmd(prevTo, -(days - 1));
  const previous = await loadJobsForWindow(query, prevFrom, prevTo);
  const prevJobs = previous.rows.map((r) => rowToAnalysisJob(r, labelMapping));
  const previousDimensions = computeDimensions(prevJobs);
  const trend = dimensionTrend(dimensions, previousDimensions);

  const recommendations = buildRecommendations(jobs, dimensions, byTaskType);

  const dataGaps: string[] = [];
  if (current.truncated) {
    dataGaps.push("Dữ liệu bị cắt ở 10k job — chỉ số có thể lệch.");
  }
  dataGaps.push(
    "Chưa có CI/review/diff size trong DB — đánh giá dựa trên status, thời gian, token, labels GitLab (mapping do admin cấu hình).",
  );
  if (jobs.every((j) => !j.tokensTotal)) {
    dataGaps.push("Thiếu token usage trên nhiều job — trụ hiệu quả token có thể không chính xác.");
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
    recommendations,
    dataGaps,
  };

  await saveDevAnalysisCache({
    ownerUsername,
    workspaceProjectId,
    from: fromYmd,
    to: toYmd,
    jobCount: current.totalInRange,
    labelConfigAt,
    result,
  });

  return result;
}
