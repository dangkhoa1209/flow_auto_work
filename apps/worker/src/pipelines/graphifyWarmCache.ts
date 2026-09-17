/**
 * Copy warm graphify-out from REPO_CACHE_ROOT and rewrite absolute source paths
 * so the agent queries the worktree corpus (M2).
 */
import { access, constants, copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

async function exists(p: string): Promise<boolean> {
  try {
    await access(p, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function copyDir(src: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true });
  const entries = await readdir(src, { withFileTypes: true });
  for (const ent of entries) {
    const from = path.join(src, ent.name);
    const to = path.join(dest, ent.name);
    if (ent.isDirectory()) {
      await copyDir(from, to);
    } else if (ent.isFile()) {
      await copyFile(from, to);
    }
  }
}

/**
 * Rewrite abs paths inside graph.json (and .json companions). Returns false if
 * verification of sample paths fails → caller should fall back to incremental rebuild.
 */
export async function prepareWorktreeGraphify(opts: {
  cacheGraphifyOut: string;
  worktreeSource: string;
  worktreeGraphifyOut: string;
  cacheSourcePath: string;
  onLog?: (msg: string) => void;
}): Promise<{ ok: boolean; usedCache: boolean }> {
  const log = opts.onLog ?? (() => undefined);
  const { cacheGraphifyOut, worktreeSource, worktreeGraphifyOut, cacheSourcePath } =
    opts;

  if (!(await exists(cacheGraphifyOut))) {
    log("No warm graphify cache — will rely on incremental/full build");
    return { ok: false, usedCache: false };
  }

  log(`Copying graphify warm cache → ${worktreeGraphifyOut}`);
  await copyDir(cacheGraphifyOut, worktreeGraphifyOut);

  const graphJsonPath = path.join(worktreeGraphifyOut, "graph.json");
  if (!(await exists(graphJsonPath))) {
    log("graph.json missing after copy");
    return { ok: false, usedCache: true };
  }

  const oldPath = path.resolve(cacheSourcePath).replace(/\\/g, "/");
  const newPath = path.resolve(worktreeSource).replace(/\\/g, "/");
  const raw = await readFile(graphJsonPath, "utf8");
  if (oldPath && oldPath !== newPath && raw.includes(oldPath)) {
    const updated = raw.split(oldPath).join(newPath);
    await writeFile(graphJsonPath, updated, "utf8");
    log("Rewrote graph.json source paths for worktree");
  }

  // Quick verify (<100ms): sample a few absolute paths from graph.json
  try {
    const parsed = JSON.parse(await readFile(graphJsonPath, "utf8")) as unknown;
    const samples = collectSamplePaths(parsed, newPath).slice(0, 2);
    for (const sample of samples) {
      if (!(await exists(sample))) {
        log(`Graphify path rewrite check failed for ${sample}`);
        return { ok: false, usedCache: true };
      }
    }
  } catch {
    log("Graphify verify parse failed — fallback to rebuild");
    return { ok: false, usedCache: true };
  }

  return { ok: true, usedCache: true };
}

function collectSamplePaths(node: unknown, mustContain: string, out: string[] = []): string[] {
  if (out.length >= 5) return out;
  if (typeof node === "string") {
    if (
      node.includes(mustContain) &&
      (node.endsWith(".ts") ||
        node.endsWith(".tsx") ||
        node.endsWith(".js") ||
        node.endsWith(".vue") ||
        node.endsWith(".php") ||
        node.endsWith(".md"))
    ) {
      out.push(node);
    }
    return out;
  }
  if (Array.isArray(node)) {
    for (const item of node) collectSamplePaths(item, mustContain, out);
    return out;
  }
  if (node && typeof node === "object") {
    for (const v of Object.values(node as Record<string, unknown>)) {
      collectSamplePaths(v, mustContain, out);
    }
  }
  return out;
}
