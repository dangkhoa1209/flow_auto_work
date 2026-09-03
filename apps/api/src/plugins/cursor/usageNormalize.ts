/** Cursor SDK usage shapes vary (camelCase, snake_case, nested `.usage`). */

export const CURSOR_USAGE_KINDS = [
  "ba_chat",
  "ba_workflow",
  "ba_create_issue",
  "job_run",
  "job_qa",
  "job_testcase",
  "job_merge",
  "stats_analyze",
  "job_legacy",
] as const;

export type CursorUsageKind = (typeof CURSOR_USAGE_KINDS)[number];

export type NormalizedCursorUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  /** Actual bill from SDK when present */
  chargedCents: number | null;
  estimatedCents: number;
  costCents: number;
  costSource: "sdk" | "estimated";
  fromSdk: boolean;
};

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function firstNum(obj: Record<string, unknown>, keys: string[]): number {
  for (const k of keys) {
    const n = num(obj[k]);
    if (n > 0) return n;
  }
  return 0;
}

/** cents from dollars, or already-cents fields */
function pickChargedCents(obj: Record<string, unknown>): number | null {
  const cents = firstNum(obj, [
    "chargedCents",
    "charged_cents",
    "costCents",
    "cost_cents",
    "billedCents",
    "billed_cents",
  ]);
  if (cents > 0) return Math.round(cents);
  const usd = firstNum(obj, [
    "chargedUsd",
    "charged_usd",
    "costUsd",
    "cost_usd",
    "totalCost",
    "total_cost",
  ]);
  if (usd > 0) {
    // Heuristic: values < 1000 treated as USD, else already cents
    const asCents = usd < 1000 ? usd * 100 : usd;
    return Math.round(asCents);
  }
  return null;
}

export function asUsageRecord(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (o.usage && typeof o.usage === "object") {
    return o.usage as Record<string, unknown>;
  }
  return o;
}

export function hasTokenLikeFields(obj: Record<string, unknown>): boolean {
  return (
    firstNum(obj, [
      "inputTokens",
      "input_tokens",
      "promptTokens",
      "prompt_tokens",
      "outputTokens",
      "output_tokens",
      "completionTokens",
      "completion_tokens",
      "totalTokens",
      "total_tokens",
      "cacheReadTokens",
      "cache_read_tokens",
      "chargedCents",
      "charged_cents",
    ]) > 0 || pickChargedCents(obj) != null
  );
}

export function normalizeUsageFields(
  obj: Record<string, unknown> | null,
  opts?: {
    promptChars?: number;
    outputChars?: number;
    usdPerMillionInput: number;
    usdPerMillionOutput: number;
  },
): NormalizedCursorUsage {
  const inputFromSdk = obj
    ? firstNum(obj, [
        "inputTokens",
        "input_tokens",
        "promptTokens",
        "prompt_tokens",
        "inputTokenCount",
      ])
    : 0;
  const outputFromSdk = obj
    ? firstNum(obj, [
        "outputTokens",
        "output_tokens",
        "completionTokens",
        "completion_tokens",
        "outputTokenCount",
      ])
    : 0;
  const cacheRead = obj
    ? firstNum(obj, [
        "cacheReadTokens",
        "cache_read_tokens",
        "cachedTokens",
        "cached_tokens",
      ])
    : 0;
  const cacheWrite = obj
    ? firstNum(obj, ["cacheWriteTokens", "cache_write_tokens"])
    : 0;
  const totalFromSdk = obj
    ? firstNum(obj, ["totalTokens", "total_tokens", "tokenCount"])
    : 0;

  const fromSdk =
    Boolean(obj) &&
    (inputFromSdk > 0 ||
      outputFromSdk > 0 ||
      totalFromSdk > 0 ||
      cacheRead > 0 ||
      cacheWrite > 0 ||
      pickChargedCents(obj ?? {}) != null);

  const inEst = Math.max(0, Math.ceil((opts?.promptChars ?? 0) / 4));
  const outEst = Math.max(0, Math.ceil((opts?.outputChars ?? 0) / 4));

  const inputTokens = fromSdk ? inputFromSdk : inEst;
  const outputTokens = fromSdk ? outputFromSdk : outEst;
  const totalTokens =
    (fromSdk && totalFromSdk > 0
      ? totalFromSdk
      : inputTokens + outputTokens + cacheRead + cacheWrite) ||
    inputTokens + outputTokens;

  const usdIn = opts?.usdPerMillionInput ?? 1.25;
  const usdOut = opts?.usdPerMillionOutput ?? 10;
  const billableInput = inputTokens + cacheRead * 0.1 + cacheWrite * 1.25;
  const estimatedUsd =
    (billableInput / 1_000_000) * usdIn + (outputTokens / 1_000_000) * usdOut;
  const estimatedCents = Math.round(estimatedUsd * 100);

  const chargedCents = obj ? pickChargedCents(obj) : null;
  const costSource: "sdk" | "estimated" =
    chargedCents != null && chargedCents > 0 ? "sdk" : "estimated";

  return {
    inputTokens,
    outputTokens,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    totalTokens,
    chargedCents,
    estimatedCents,
    costCents: costSource === "sdk" ? chargedCents! : estimatedCents,
    costSource,
    fromSdk,
  };
}

export function pickUsageFromCandidates(
  ...candidates: unknown[]
): Record<string, unknown> | null {
  for (const c of candidates) {
    const rec = asUsageRecord(c);
    if (rec && hasTokenLikeFields(rec)) return rec;
    if (rec && rec.usage && typeof rec.usage === "object") {
      const nested = rec.usage as Record<string, unknown>;
      if (hasTokenLikeFields(nested)) return nested;
    }
  }
  return null;
}

export type UsageCounters = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costCents: number;
  chargedCents: number;
  estimatedCents: number;
};

export function emptyUsageCounters(): UsageCounters {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    costCents: 0,
    chargedCents: 0,
    estimatedCents: 0,
  };
}

export function addUsageCounters(
  acc: UsageCounters,
  row: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    totalTokens?: number;
    costCents?: number;
    chargedCents?: number | null;
    estimatedCents?: number;
  },
): void {
  acc.inputTokens += row.inputTokens || 0;
  acc.outputTokens += row.outputTokens || 0;
  acc.cacheReadTokens += row.cacheReadTokens || 0;
  acc.cacheWriteTokens += row.cacheWriteTokens || 0;
  acc.totalTokens += row.totalTokens || 0;
  acc.costCents += row.costCents || 0;
  acc.chargedCents += row.chargedCents || 0;
  acc.estimatedCents += row.estimatedCents || 0;
}

/**
 * Agent.getUsage() is often lifetime-cumulative. If this snapshot is at least
 * as large as already-persisted totals for the same agent, store the delta.
 */
export function maybeDeltaFromCumulative(
  current: NormalizedCursorUsage,
  previous: UsageCounters,
): NormalizedCursorUsage {
  if (!current.fromSdk || previous.totalTokens <= 0) return current;
  if (current.totalTokens + 16 < previous.totalTokens) return current;

  const inputTokens = Math.max(0, current.inputTokens - previous.inputTokens);
  const outputTokens = Math.max(0, current.outputTokens - previous.outputTokens);
  const cacheReadTokens = Math.max(
    0,
    current.cacheReadTokens - previous.cacheReadTokens,
  );
  const cacheWriteTokens = Math.max(
    0,
    current.cacheWriteTokens - previous.cacheWriteTokens,
  );
  const totalTokens = Math.max(
    0,
    current.totalTokens - previous.totalTokens,
  );
  const estimatedCents = Math.max(
    0,
    current.estimatedCents - previous.estimatedCents,
  );
  const chargedCents =
    current.chargedCents != null
      ? Math.max(0, current.chargedCents - previous.chargedCents)
      : null;
  const costCents =
    chargedCents != null && chargedCents > 0
      ? chargedCents
      : Math.max(0, current.costCents - previous.costCents);

  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens,
    chargedCents,
    estimatedCents,
    costCents,
    costSource:
      chargedCents != null && chargedCents > 0 ? "sdk" : "estimated",
    fromSdk: true,
  };
}

export const USAGE_KIND_LABELS: Record<CursorUsageKind, string> = {
  ba_chat: "BA Chat",
  ba_workflow: "BA workflow",
  ba_create_issue: "Create issue",
  job_run: "Work run",
  job_qa: "Work Q&A",
  job_testcase: "QC testcase",
  job_merge: "Merge AI",
  stats_analyze: "Dev evaluation",
  job_legacy: "Work (legacy)",
};
