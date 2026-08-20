export function median(nums: number[]): number | null {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export function successRate(succeeded: number, failed: number): number | null {
  const done = succeeded + failed;
  if (!done) return null;
  return Math.round((succeeded / done) * 1000) / 10;
}

export function pctChange(current: number, previous: number): number | null {
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return null;
  if (previous === 0) return current === 0 ? 0 : null;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

export function avg(sum: number, count: number): number | null {
  if (!count) return null;
  return sum / count;
}

export function classifyFailReason(error?: string | null): string {
  const raw = (error || "").trim();
  if (!raw) return "(no reason)";
  const lower = raw.toLowerCase();
  if (lower.includes("force stop") || lower.includes("force-stop")) {
    return "Force stop";
  }
  if (lower.includes("timeout") || lower.includes("etimedout")) {
    return "Timeout";
  }
  if (lower.includes("token budget") || lower.includes("token budget")) {
    return "Token budget";
  }
  if (lower.includes("transient") || lower.includes("không kết nối")) {
    return "Cursor transport";
  }
  const first = raw.split(/\n/)[0] || raw;
  return first.slice(0, 80);
}

export function estimateUsd(
  inputTokens: number,
  outputTokens: number,
  usdPerMillionInput: number,
  usdPerMillionOutput: number,
): number {
  return (
    (inputTokens / 1_000_000) * usdPerMillionInput +
    (outputTokens / 1_000_000) * usdPerMillionOutput
  );
}
