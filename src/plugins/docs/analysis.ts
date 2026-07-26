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
    if (/^SUMMARY\s*:/i.test(line)) {
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

/** Short VI summary without the DOCS: path list */
export function docsReadySummaryText(summaryBody: string): string {
  const withoutDocsSection = summaryBody
    .replace(/\n?(DOCS|PATHS)\s*:?\s*\n[\s\S]*$/i, "")
    .replace(/^SUMMARY\s*:\s*/im, "")
    .trim();
  return withoutDocsSection || summaryBody.trim();
}
