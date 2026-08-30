/**
 * Parse Figma URLs from free text (issue description, chat, Dev Notes).
 */

export type FigmaUrlKind = "design" | "file" | "proto" | "board" | "other";

export type FigmaRef = {
  fileKey: string;
  /** Figma API form `1:2` (from URL `node-id=1-2` or `1:2`). */
  nodeId?: string;
  url: string;
  kind: FigmaUrlKind;
};

const FIGMA_URL_RE =
  /https?:\/\/(?:www\.)?figma\.com\/(design|file|proto|board|figjam)\/([a-zA-Z0-9]+)(?:\/[^\s)\]>"']*)?/gi;

/** Stable opt-in key for job.figmaIncludeKeys. */
export function figmaIncludeKey(ref: Pick<FigmaRef, "fileKey" | "nodeId">): string {
  const node = (ref.nodeId || "").trim();
  return node ? `${ref.fileKey}#${node}` : ref.fileKey;
}

export function parseFigmaIncludeKey(key: string): {
  fileKey: string;
  nodeId?: string;
} {
  const raw = String(key || "").trim();
  const hash = raw.indexOf("#");
  if (hash < 0) return { fileKey: raw };
  const fileKey = raw.slice(0, hash).trim();
  const nodeId = raw.slice(hash + 1).trim() || undefined;
  return { fileKey, nodeId };
}

function kindFromPath(seg: string): FigmaUrlKind {
  const s = seg.toLowerCase();
  if (s === "design") return "design";
  if (s === "file") return "file";
  if (s === "proto") return "proto";
  if (s === "board" || s === "figjam") return "board";
  return "other";
}

/** Normalize URL node-id (`1-2` / `1:2`) → API id `1:2`. */
export function normalizeFigmaNodeId(raw: string | undefined | null): string | undefined {
  const t = String(raw || "")
    .trim()
    .replace(/%3A/gi, ":")
    .replace(/%2D/gi, "-");
  if (!t) return undefined;
  const withColon = t.includes(":") ? t : t.replace(/-/g, ":");
  return withColon || undefined;
}

function extractNodeIdFromUrl(full: string): string | undefined {
  try {
    const u = new URL(full.replace(/[.,;]+$/, ""));
    const fromQuery =
      u.searchParams.get("node-id") || u.searchParams.get("node_id");
    if (fromQuery) return normalizeFigmaNodeId(fromQuery);
  } catch {
    /* fall through */
  }
  const m = full.match(/[?&#]node[-_]id=([^&#\s)\]>"']+)/i);
  return m ? normalizeFigmaNodeId(decodeURIComponent(m[1]!)) : undefined;
}

/** Parse Figma design/file/proto/board links from free text. */
export function extractFigmaRefs(text: string): FigmaRef[] {
  if (!text?.trim()) return [];
  const out: FigmaRef[] = [];
  const seen = new Set<string>();
  const re = new RegExp(FIGMA_URL_RE.source, FIGMA_URL_RE.flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const full = m[0].replace(/[.,;]+$/, "");
    const kind = kindFromPath(m[1] || "");
    const fileKey = m[2];
    if (!fileKey) continue;
    const nodeId = extractNodeIdFromUrl(full);
    const ref: FigmaRef = { fileKey, nodeId, url: full, kind };
    const key = figmaIncludeKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}

export function collectFigmaRefsFromTexts(texts: string[]): FigmaRef[] {
  const map = new Map<string, FigmaRef>();
  for (const t of texts) {
    for (const ref of extractFigmaRefs(t)) {
      const key = figmaIncludeKey(ref);
      const prev = map.get(key);
      if (!prev) {
        map.set(key, ref);
        continue;
      }
      // Prefer design/file over proto/board when same key appears
      const rank = (k: FigmaUrlKind) =>
        k === "design" || k === "file" ? 2 : k === "proto" ? 1 : 0;
      if (rank(ref.kind) > rank(prev.kind)) map.set(key, ref);
      else if (!prev.nodeId && ref.nodeId) map.set(key, ref);
    }
  }
  return [...map.values()];
}

/** Prefer full read for design/file; proto/board → metadata-only. */
export function isFigmaFullReadKind(kind: FigmaUrlKind): boolean {
  return kind === "design" || kind === "file";
}
