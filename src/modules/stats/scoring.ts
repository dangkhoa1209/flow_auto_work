import { median, successRate } from "./metrics.js";

export type SkillDimensions = {
  speed: number;
  accuracy: number;
  scope: number;
  consistency: number;
  efficiency: number;
};

export type AnalysisJob = {
  jobId: string;
  issueIid: number;
  title: string;
  url: string;
  status: string;
  durationMs: number | null;
  tokensTotal: number;
  runCount: number;
  taskType: string;
  failReason?: string;
};

function clamp(n: number, lo = 0, hi = 100): number {
  return Math.max(lo, Math.min(hi, Math.round(n * 10) / 10));
}

function stddev(nums: number[]): number {
  if (nums.length < 2) return 0;
  const mean = nums.reduce((s, n) => s + n, 0) / nums.length;
  const v =
    nums.reduce((s, n) => s + (n - mean) ** 2, 0) / (nums.length - 1);
  return Math.sqrt(v);
}

/** 0–100 skill scores from job rows (terminal jobs weighted for accuracy). */
export function computeDimensions(jobs: AnalysisJob[]): SkillDimensions {
  if (!jobs.length) {
    return { speed: 0, accuracy: 0, scope: 0, consistency: 0, efficiency: 0 };
  }

  const terminal = jobs.filter((j) =>
    ["succeeded", "failed"].includes(j.status),
  );
  const succeeded = jobs.filter((j) => j.status === "succeeded");
  const failed = jobs.filter((j) => j.status === "failed");

  const durations = succeeded
    .map((j) => j.durationMs)
    .filter((n): n is number => n != null && n > 0);
  const userMedian = median(durations) ?? 0;
  const hours = userMedian / 3_600_000;
  const speed =
    userMedian > 0 ? clamp(100 - (hours / 6) * 70, 15, 95) : 40;

  const rate = successRate(succeeded.length, failed.length);
  const accuracy = rate ?? 0;

  const byType = new Map<string, { ok: number; fail: number }>();
  for (const j of terminal) {
    const t = j.taskType || "other";
    let b = byType.get(t);
    if (!b) {
      b = { ok: 0, fail: 0 };
      byType.set(t, b);
    }
    if (j.status === "succeeded") b.ok += 1;
    else b.fail += 1;
  }
  const overallFail =
    terminal.length > 0 ? failed.length / terminal.length : 0;
  let worstExcess = 0;
  for (const [, v] of byType) {
    const done = v.ok + v.fail;
    if (done < 2) continue;
    const fr = v.fail / done;
    worstExcess = Math.max(worstExcess, fr - overallFail);
  }
  const scope = clamp(100 - worstExcess * 200);

  const meanDur =
    durations.length > 0
      ? durations.reduce((s, n) => s + n, 0) / durations.length
      : 0;
  const cv = meanDur > 0 ? stddev(durations) / meanDur : 0;
  const consistency = clamp(100 - cv * 120);

  const tokens = succeeded
    .map((j) => j.tokensTotal)
    .filter((n) => n > 0);
  const medTok = median(tokens) ?? 0;
  const efficiency =
    medTok > 0 ? clamp(100 - (medTok / 400_000) * 55, 10, 95) : 50;

  return {
    speed,
    accuracy,
    scope,
    consistency,
    efficiency,
  };
}

export function dimensionTrend(
  current: SkillDimensions,
  previous: SkillDimensions,
): Record<keyof SkillDimensions, number | null> {
  const keys = [
    "speed",
    "accuracy",
    "scope",
    "consistency",
    "efficiency",
  ] as const;
  const out = {} as Record<keyof SkillDimensions, number | null>;
  for (const k of keys) {
    const d = current[k] - previous[k];
    out[k] = Number.isFinite(d) ? Math.round(d * 10) / 10 : null;
  }
  return out;
}
