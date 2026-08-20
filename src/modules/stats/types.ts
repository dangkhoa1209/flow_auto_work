export type StatsDayItem = {
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

export type StatsCounts = {
  jobCount: number;
  awaitingHandoff: number;
  succeeded: number;
  failed: number;
  runningLike: number;
  tokensTotal: number;
  tokensInput: number;
  tokensOutput: number;
  tokensAvgPerJob: number | null;
  successRate: number | null;
  durationAvgMs: number | null;
  durationMedianMs: number | null;
};

export type StatsDayBucket = StatsCounts & {
  date: string;
  spark: number[];
  items: StatsDayItem[];
};

export type StatsWeekNode = StatsCounts & {
  weekKey: string;
  label: string;
  weekStart: string;
  weekEnd: string;
  spark: number[];
  days: StatsDayBucket[];
};

export type StatsMonthNode = StatsCounts & {
  monthKey: string;
  label: string;
  spark: number[];
  weeks: StatsWeekNode[];
};

export type ProjectTokens = {
  workspaceProjectId: string;
  jobs: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

export type FailReasonRow = {
  reason: string;
  count: number;
};

export type InsightJob = {
  jobId: string;
  issueIid: number;
  title: string;
  url: string;
  status: string;
  tokensTotal: number;
  durationMs: number | null;
  date: string;
};

export type PeriodCompare = {
  jobsPct: number | null;
  tokensPct: number | null;
  successRateDelta: number | null;
  previousJobs: number;
  previousTokens: number;
};
