import { readFile, access } from "node:fs/promises";
import path from "node:path";
import { constants } from "node:fs";

const DOC_EXT = /\.(md|mdc)$/i;

/** Allow docs + rules paths (.md / .mdc), path-traversal safe. */
export function normalizeDocsRelPath(rel: string): string | null {
  const cleaned = rel
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "");
  if (!cleaned || cleaned.includes("..")) return null;
  if (!DOC_EXT.test(cleaned)) return null;
  if (
    !cleaned.startsWith("docs/") &&
    !cleaned.startsWith(".cursor/rules/")
  ) {
    return null;
  }
  return cleaned;
}

export async function readRepoDoc(
  repoPath: string,
  relPath: string,
): Promise<{ path: string; content: string | null; exists: boolean }> {
  const rel = normalizeDocsRelPath(relPath);
  if (!rel) {
    return { path: relPath, content: null, exists: false };
  }
  const abs = path.join(repoPath, rel);
  try {
    await access(abs, constants.R_OK);
    const content = await readFile(abs, "utf8");
    return { path: rel, content, exists: true };
  } catch {
    return { path: rel, content: null, exists: false };
  }
}

export async function readRepoDocs(
  repoPath: string,
  relPaths: string[],
): Promise<Array<{ path: string; content: string | null; exists: boolean }>> {
  const unique = [...new Set(relPaths.map((p) => p.trim()).filter(Boolean))];
  const out = [];
  for (const p of unique) {
    out.push(await readRepoDoc(repoPath, p));
  }
  return out;
}

const DOCS_READY_SECTION =
  /^(ANALYZED|SUMMARY|DOCS|PATHS)\s*:?\s*$/i;
const DOCS_READY_INLINE =
  /^(ANALYZED|SUMMARY)\s*:\s*(.*)$/i;

/**
 * Extract one labeled section from a DOCS_READY body (ANALYZED / SUMMARY / …).
 * Supports `FIELD: text` on one line or `FIELD:` then following lines until next field.
 */
export function docsReadySection(
  summaryBody: string,
  field: "ANALYZED" | "SUMMARY" | "DOCS" | "PATHS",
): string {
  const lines = summaryBody.split(/\r?\n/);
  const want = field.toUpperCase();
  const out: string[] = [];
  let inField = false;
  for (const raw of lines) {
    const inline = raw.match(DOCS_READY_INLINE);
    if (inline) {
      const name = inline[1].toUpperCase();
      if (name === want) {
        inField = true;
        if (inline[2]?.trim()) out.push(inline[2].trim());
        continue;
      }
      if (inField) break;
      continue;
    }
    if (DOCS_READY_SECTION.test(raw.trim())) {
      const name = raw
        .trim()
        .replace(/\s*:?\s*$/, "")
        .toUpperCase();
      if (name === want) {
        inField = true;
        continue;
      }
      if (inField) break;
      continue;
    }
    if (inField) out.push(raw);
  }
  return out.join("\n").trim();
}

/**
 * Parse DOCS_READY body for feature doc / rule paths the agent touched or cited.
 * Accepts .md and .mdc under docs/ or .cursor/rules/
 */
export function parseDocsReadyPaths(summaryBody: string): string[] {
  const paths: string[] = [];
  const lines = summaryBody.split(/\r?\n/);
  let inDocs = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (/^DOCS\s*:?\s*$/i.test(line) || /^PATHS\s*:?\s*$/i.test(line)) {
      inDocs = true;
      continue;
    }
    if (/^(SUMMARY|ANALYZED)\s*:/i.test(line)) {
      inDocs = false;
      continue;
    }
    const bullet = line.replace(/^[-*]\s+/, "").trim();
    const normalized = normalizeDocsRelPath(bullet);
    if (normalized) {
      paths.push(normalized);
      continue;
    }
    const m = line.match(
      /(?:docs|\.cursor\/rules)\/[A-Za-z0-9_./-]+\.(?:md|mdc)/i,
    );
    if (m) {
      const n = normalizeDocsRelPath(m[0]);
      if (n) paths.push(n);
    }
    if (inDocs && !line) {
      inDocs = false;
    }
  }
  return [...new Set(paths)];
}

/** Short VI summary without the DOCS: path list (prefers SUMMARY, keeps ANALYZED if present). */
export function docsReadySummaryText(summaryBody: string): string {
  const analyzed = docsReadySection(summaryBody, "ANALYZED");
  const summary = docsReadySection(summaryBody, "SUMMARY");
  if (analyzed || summary) {
    return [analyzed && `Đã phân tích:\n${analyzed}`, summary && `Đã cập nhật docs:\n${summary}`]
      .filter(Boolean)
      .join("\n\n");
  }
  const withoutDocsSection = summaryBody
    .replace(/\n?(DOCS|PATHS)\s*:?\s*\n[\s\S]*$/i, "")
    .replace(/^(ANALYZED|SUMMARY)\s*:\s*/gim, "")
    .trim();
  return withoutDocsSection || summaryBody.trim();
}

/** Chat message after docs phase — analysis + doc changes + paths. */
export function formatDocsReadyChatBody(
  summaryBody: string,
  paths: string[],
): string {
  const analyzed = docsReadySection(summaryBody, "ANALYZED");
  const summary =
    docsReadySection(summaryBody, "SUMMARY") ||
    summaryBody
      .replace(/\n?(DOCS|PATHS)\s*:?\s*\n[\s\S]*$/i, "")
      .replace(/^ANALYZED\s*:?\s*[\s\S]*?(?=^SUMMARY\s*:|$)/im, "")
      .replace(/^SUMMARY\s*:\s*/im, "")
      .trim();

  const parts: string[] = ["DOCS READY:"];
  if (analyzed) {
    parts.push("", "### Đã phân tích", analyzed);
  }
  if (summary) {
    parts.push("", "### Đã cập nhật docs", summary);
  }
  if (!analyzed && !summary) {
    const fallback = docsReadySummaryText(summaryBody) || summaryBody.slice(0, 500);
    if (fallback) parts.push("", fallback);
  }
  if (paths.length) {
    parts.push("", "### Paths", ...paths.map((p) => `- ${p}`));
  }
  return parts.join("\n").trim();
}
