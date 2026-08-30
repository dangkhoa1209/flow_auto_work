import { readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { RequestHandler, Router } from "express";
import { Router as createRouter } from "express";
import { logger } from "../logger.js";

export type RouteModule = {
  /** Mount path under the parent router, e.g. `/jobs`. Use `/` for root-level routes. */
  routePath: string;
  /** Preferred: `createXxxRoutes(): Router` or `default`. */
  default?: () => Router;
  [key: string]: unknown;
};

function resolveCreate(mod: RouteModule, file: string): () => Router {
  if (typeof mod.default === "function") {
    return mod.default as () => Router;
  }
  const named = Object.entries(mod).find(
    ([key, value]) =>
      key.startsWith("create") &&
      key.endsWith("Routes") &&
      typeof value === "function",
  );
  if (named) {
    return named[1] as () => Router;
  }
  throw new Error(
    `processRoutePath: ${file} must export routePath + create*Routes() (or default)`,
  );
}

function normalizeMount(routePath: string): string {
  const p = routePath.trim() || "/";
  if (p === "/") return "/";
  return p.startsWith("/") ? p.replace(/\/+$/, "") : `/${p.replace(/\/+$/, "")}`;
}

/**
 * Auto-mount Express routers from a routes directory (ft_hts-style processRoutePath).
 *
 * Convention per file (`*Routes.ts`, except `index.ts`):
 * - `export const routePath = "/jobs"`
 * - `export function createJobRoutes(): Router` (or `export default`)
 *
 * Static folders first is N/A here (flat *Routes files). Param folders `[id]`
 * are not used — Express `:id` lives inside each router.
 */
export async function processRoutePath(
  app: Router,
  routesDir: string,
  options?: {
    middlewares?: RequestHandler | RequestHandler[];
    /** Optional path prefix prepended to each routePath (e.g. already on /api) */
    prefix?: string;
  },
): Promise<void> {
  const middlewares = (() => {
    const m = options?.middlewares;
    if (!m) return [] as RequestHandler[];
    return Array.isArray(m) ? m.filter(Boolean) : [m];
  })();
  const prefix = (options?.prefix || "").replace(/\/+$/, "");

  const entries = await readdir(routesDir);
  const files = entries
    .filter(
      (f) =>
        (f.endsWith("Routes.ts") || f.endsWith("Routes.js")) &&
        f !== "index.ts" &&
        f !== "index.js",
    )
    .sort((a, b) => {
      // Mount root (`routePath: "/"`) last so named mounts win first
      const aRoot = a.toLowerCase().startsWith("root");
      const bRoot = b.toLowerCase().startsWith("root");
      if (aRoot !== bRoot) return aRoot ? 1 : -1;
      return a.localeCompare(b);
    });

  for (const filename of files) {
    const filepath = path.join(routesDir, filename);
    const mod = (await import(pathToFileURL(filepath).href)) as RouteModule;
    if (typeof mod.routePath !== "string") {
      throw new Error(`processRoutePath: ${filename} missing export routePath`);
    }
    const create = resolveCreate(mod, filename);
    const router = create();
    const mount = normalizeMount(mod.routePath);
    const full =
      mount === "/"
        ? prefix || "/"
        : `${prefix}${mount}`.replace(/\/{2,}/g, "/");

    if (middlewares.length > 0) {
      if (full === "/" || full === "") {
        app.use(...middlewares, router);
      } else {
        app.use(full, ...middlewares, router);
      }
    } else if (full === "/" || full === "") {
      app.use(router);
    } else {
      app.use(full, router);
    }

    logger.debug("Mounted route module", {
      file: filename,
      path: full === "/" ? "/" : full,
    });
  }
}

/** Sync-friendly factory when routesDir is known at boot. */
export async function createRouterFromPath(
  routesDir: string,
  options?: {
    middlewares?: RequestHandler | RequestHandler[];
  },
): Promise<Router> {
  const api = createRouter();
  await processRoutePath(api, routesDir, options);
  return api;
}
