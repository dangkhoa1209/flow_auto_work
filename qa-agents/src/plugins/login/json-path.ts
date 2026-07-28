/** Pure helpers — no logger/config imports (easy to unit test). */

export function extractJsonPath(data: unknown, path: string): string | null {
  const parts = path.split(".").map((p) => p.trim()).filter(Boolean);
  let cur: unknown = data;
  for (const part of parts) {
    if (cur == null || typeof cur !== "object") return null;
    cur = (cur as Record<string, unknown>)[part];
  }
  if (typeof cur === "string" && cur.trim()) return cur.trim();
  if (typeof cur === "number") return String(cur);
  return null;
}

export function maskSecrets(text: string): string {
  let out = text;
  out = out.replace(
    /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
    "[JWT_REDACTED]",
  );
  out = out.replace(
    /(password|passwd|pwd|token|secret|authorization)\s*[:=]\s*["']?[^\s"',}]+/gi,
    "$1=[REDACTED]",
  );
  return out;
}
