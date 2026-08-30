import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

let cached: string | undefined;

/**
 * Monorepo root (directory with workspaces), not apps/api.
 * Keeps `.env`, `project/`, `data/`, `uploads/` at repo root regardless of cwd.
 */
export function getRepoRoot(): string {
  if (cached) return cached;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i++) {
    const pkgPath = join(dir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
          workspaces?: unknown;
        };
        if (pkg.workspaces) {
          cached = dir;
          return dir;
        }
      } catch {
        /* continue climbing */
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  cached = process.cwd();
  return cached;
}
