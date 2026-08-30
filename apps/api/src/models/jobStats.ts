import { withActive } from "./base.js";
import { JobModel } from "./job.js";
import { connectMongo } from "./connection.js";

async function jobsCol() {
  await connectMongo();
  return JobModel.col();
}

const STATS_TZ = "Asia/Ho_Chi_Minh";
const STATS_HARD_CAP = 10_000;

const attributedAtExpr = {
  $let: {
    vars: {
      raw: {
        $ifNull: [
          "$completedAt",
          { $ifNull: ["$handedOffAt", { $ifNull: ["$updatedAt", "$createdAt"] }] },
        ],
      },
    },
    in: {
      $switch: {
        branches: [
          {
            case: { $eq: [{ $type: "$$raw" }, "date"] },
            then: "$$raw",
          },
        ],
        default: {
          $dateFromString: {
            dateString: "$$raw",
            onError: null,
            onNull: null,
          },
        },
      },
    },
  },
};

function toDateExpr(field: string) {
  return {
    $cond: [
      { $eq: [{ $type: `$${field}` }, "date"] },
      `$${field}`,
      {
        $dateFromString: {
          dateString: `$${field}`,
          onError: null,
          onNull: null,
        },
      },
    ],
  };
}

export type JobStatsAggQuery = {
  workspaceProjectId?: string;
  ownerUsername?: string;
  statuses?: string[];
  rangeStart: Date;
  rangeEnd: Date;
  q?: string;
  hardCap?: number;
};

export type JobStatsAggRow = {
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
};

export type JobStatsAggResult = {
  totalInRange: number;
  truncated: boolean;
  rows: JobStatsAggRow[];
  owners: string[];
  projects: string[];
};

function statsMatchFilter(opts: JobStatsAggQuery): Record<string, unknown> {
  const filter: Record<string, unknown> = {};
  if (opts.workspaceProjectId) {
    filter.workspaceProjectId = opts.workspaceProjectId;
  }
  if (opts.ownerUsername) filter.ownerUsername = opts.ownerUsername;
  if (opts.statuses?.length) filter.status = { $in: opts.statuses };
  const q = opts.q?.trim();
  if (q) {
    const iid = Number(q.replace(/^#/, ""));
    const or: Record<string, unknown>[] = [
      { "issue.title": { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" } },
    ];
    if (Number.isFinite(iid) && iid > 0) {
      or.push({ "issue.issueIid": iid });
    }
    filter.$or = or;
  }
  return withActive(filter) as Record<string, unknown>;
}

/**
 * Load attributed jobs in a date window via aggregation (no silent 500 cap).
 * Caps at 10k most-recent attributed rows and reports truncation.
 */
export async function aggregateJobsForStats(
  opts: JobStatsAggQuery,
): Promise<JobStatsAggResult> {
  await connectMongo();
  const cap = opts.hardCap ?? STATS_HARD_CAP;
  const match = statsMatchFilter(opts);

  const countPipe = [
    { $match: match },
    { $addFields: { attributedAt: attributedAtExpr } },
    {
      $match: {
        attributedAt: { $ne: null, $gte: opts.rangeStart, $lte: opts.rangeEnd },
      },
    },
    { $count: "n" },
  ];

  const dataPipe = [
    { $match: match },
    { $addFields: { attributedAt: attributedAtExpr } },
    {
      $match: {
        attributedAt: { $ne: null, $gte: opts.rangeStart, $lte: opts.rangeEnd },
      },
    },
    { $sort: { attributedAt: -1 } },
    { $limit: cap },
    {
      $addFields: {
        dayKey: {
          $dateToString: {
            format: "%Y-%m-%d",
            date: "$attributedAt",
            timezone: STATS_TZ,
          },
        },
        createdAtDate: toDateExpr("createdAt"),
        endAtDate: {
          $ifNull: [toDateExpr("completedAt"), toDateExpr("updatedAt")],
        },
      },
    },
    {
      $addFields: {
        durationMs: {
          $cond: [
            {
              $and: [
                { $ne: ["$createdAtDate", null] },
                { $ne: ["$endAtDate", null] },
              ],
            },
            { $subtract: ["$endAtDate", "$createdAtDate"] },
            null,
          ],
        },
      },
    },
    {
      $project: {
        _id: 0,
        dayKey: 1,
        jobId: { $ifNull: ["$id", "$_id"] },
        status: 1,
        issueIid: { $ifNull: ["$issue.issueIid", 0] },
        title: { $ifNull: ["$issue.title", ""] },
        url: { $ifNull: ["$issue.url", ""] },
        at: {
          $dateToString: { date: "$attributedAt", format: "%Y-%m-%dT%H:%M:%S.%LZ" },
        },
        summary: 1,
        error: { $substrCP: [{ $ifNull: ["$error", ""] }, 0, 240] },
        workspaceProjectId: 1,
        ownerUsername: 1,
        tokensTotal: { $ifNull: ["$tokenUsage.totalTokens", 0] },
        tokensInput: { $ifNull: ["$tokenUsage.inputTokens", 0] },
        tokensOutput: { $ifNull: ["$tokenUsage.outputTokens", 0] },
        durationMs: 1,
      },
    },
  ];

  const col = await jobsCol();
  const [countDocs, rows] = await Promise.all([
    col.aggregate<{ n: number }>(countPipe).toArray(),
    col.aggregate<JobStatsAggRow>(dataPipe, { allowDiskUse: true }).toArray(),
  ]);

  const totalInRange = countDocs[0]?.n ?? 0;
  const owners = [
    ...new Set(rows.map((r) => r.ownerUsername).filter((x): x is string => !!x)),
  ].sort();
  const projects = [
    ...new Set(
      rows.map((r) => r.workspaceProjectId).filter((x): x is string => !!x),
    ),
  ].sort();

  return {
    totalInRange,
    truncated: totalInRange > rows.length,
    rows,
    owners,
    projects,
  };
}

export type DevAnalysisJobRow = JobStatsAggRow & {
  labels: string[];
  runCount: number;
  createdAt: string;
  completedAt?: string;
};

/** Same window/filter as stats, with labels + runCount for dev evaluation. */
export async function aggregateJobsForDevAnalysis(
  opts: JobStatsAggQuery,
): Promise<Omit<JobStatsAggResult, "rows"> & { rows: DevAnalysisJobRow[] }> {
  await connectMongo();
  const cap = opts.hardCap ?? STATS_HARD_CAP;
  const match = statsMatchFilter(opts);

  const countPipe = [
    { $match: match },
    { $addFields: { attributedAt: attributedAtExpr } },
    {
      $match: {
        attributedAt: { $ne: null, $gte: opts.rangeStart, $lte: opts.rangeEnd },
      },
    },
    { $count: "n" },
  ];

  const dataPipe = [
    { $match: match },
    { $addFields: { attributedAt: attributedAtExpr } },
    {
      $match: {
        attributedAt: { $ne: null, $gte: opts.rangeStart, $lte: opts.rangeEnd },
      },
    },
    { $sort: { attributedAt: -1 } },
    { $limit: cap },
    {
      $addFields: {
        dayKey: {
          $dateToString: {
            format: "%Y-%m-%d",
            date: "$attributedAt",
            timezone: STATS_TZ,
          },
        },
        createdAtDate: toDateExpr("createdAt"),
        endAtDate: {
          $ifNull: [toDateExpr("completedAt"), toDateExpr("updatedAt")],
        },
      },
    },
    {
      $addFields: {
        durationMs: {
          $cond: [
            {
              $and: [
                { $ne: ["$createdAtDate", null] },
                { $ne: ["$endAtDate", null] },
              ],
            },
            { $subtract: ["$endAtDate", "$createdAtDate"] },
            null,
          ],
        },
      },
    },
    {
      $project: {
        _id: 0,
        dayKey: 1,
        jobId: { $ifNull: ["$id", "$_id"] },
        status: 1,
        issueIid: { $ifNull: ["$issue.issueIid", 0] },
        title: { $ifNull: ["$issue.title", ""] },
        url: { $ifNull: ["$issue.url", ""] },
        at: {
          $dateToString: { date: "$attributedAt", format: "%Y-%m-%dT%H:%M:%S.%LZ" },
        },
        summary: 1,
        error: { $substrCP: [{ $ifNull: ["$error", ""] }, 0, 240] },
        workspaceProjectId: 1,
        ownerUsername: 1,
        tokensTotal: { $ifNull: ["$tokenUsage.totalTokens", 0] },
        tokensInput: { $ifNull: ["$tokenUsage.inputTokens", 0] },
        tokensOutput: { $ifNull: ["$tokenUsage.outputTokens", 0] },
        durationMs: 1,
        labels: { $ifNull: ["$issue.labels", []] },
        runCount: { $ifNull: ["$runCount", 0] },
        createdAt: 1,
        completedAt: 1,
      },
    },
  ];

  const col = await jobsCol();
  const [countDocs, rows] = await Promise.all([
    col.aggregate<{ n: number }>(countPipe).toArray(),
    col.aggregate<DevAnalysisJobRow>(dataPipe, { allowDiskUse: true }).toArray(),
  ]);

  const totalInRange = countDocs[0]?.n ?? 0;
  const owners = [
    ...new Set(rows.map((r) => r.ownerUsername).filter((x): x is string => !!x)),
  ].sort();
  const projects = [
    ...new Set(
      rows.map((r) => r.workspaceProjectId).filter((x): x is string => !!x),
    ),
  ].sort();

  return {
    totalInRange,
    truncated: totalInRange > rows.length,
    rows,
    owners,
    projects,
  };
}
