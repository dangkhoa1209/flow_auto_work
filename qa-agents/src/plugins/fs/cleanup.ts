import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "../../../../src/logger.js";
import { artifactsRoot } from "../../job-store.js";

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Delete artifact folders older than ttlMs (default 7 days). */
export async function cleanupOldArtifacts(
  ttlMs = DEFAULT_TTL_MS,
): Promise<number> {
  const root = artifactsRoot();
  let removed = 0;
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return 0;
  }
  const now = Date.now();
  for (const name of entries) {
    if (name.startsWith(".")) continue;
    const abs = join(root, name);
    try {
      const st = await stat(abs);
      if (!st.isDirectory()) continue;
      if (now - st.mtimeMs > ttlMs) {
        await rm(abs, { recursive: true, force: true });
        removed += 1;
      }
    } catch (err) {
      logger.warn("QA artifact cleanup skip", { name, err: String(err) });
    }
  }
  if (removed > 0) {
    logger.info("QA artifact cleanup", { removed });
  }
  return removed;
}
