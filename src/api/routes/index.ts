import path from "node:path";
import { fileURLToPath } from "node:url";
import { Router } from "express";
import { requireWorkspace } from "../middleware/workspaceAuth.js";
import { processRoutePath } from "../processRoutePath.js";

const routesDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * Express /api router — auto-mounts `*Routes.ts` via processRoutePath.
 * Each module exports `routePath` + `createXxxRoutes()`.
 */
export async function createApiRouter(): Promise<Router> {
  const api = Router();
  // Bind once on parent so req.path stays `/auth/login` (not `/login`)
  api.use(requireWorkspace);
  await processRoutePath(api, routesDir);
  return api;
}
