import fs from "node:fs/promises";
import path from "node:path";
import { resolveRepoPath } from "../../workspace/creds.js";

function resolveSafePath(repoRelative: string): string {
  const root = path.resolve(resolveRepoPath());
  const cleaned = repoRelative.replace(/^\/+/, "").replace(/\\/g, "/");
  if (
    !cleaned ||
    cleaned.includes("\0") ||
    cleaned.split("/").some((p) => p === "..")
  ) {
    throw new Error(`Unsafe path: ${repoRelative}`);
  }
  const full = path.resolve(root, cleaned);
  if (full !== root && !full.startsWith(root + path.sep)) {
    throw new Error(`Path escapes repo: ${repoRelative}`);
  }
  return full;
}

export async function readRepoFile(repoRelative: string): Promise<string> {
  const full = resolveSafePath(repoRelative);
  return fs.readFile(full, "utf8");
}

export async function writeRepoFile(
  repoRelative: string,
  content: string,
): Promise<void> {
  const full = resolveSafePath(repoRelative);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content, "utf8");
}

/** Paths touched in a unified diff (--- a/ / +++ b/). */
export function extractPathsFromUnifiedDiff(diffText: string): string[] {
  const paths = new Set<string>();
  for (const line of diffText.split("\n")) {
    const m =
      /^\+\+\+\s+b\/(.+)$/.exec(line) ||
      /^---\s+a\/(.+)$/.exec(line) ||
      /^\+\+\+\s+(.+)$/.exec(line);
    if (!m) continue;
    const p = m[1].trim();
    if (p === "/dev/null") continue;
    paths.add(p);
  }
  return [...paths];
}
