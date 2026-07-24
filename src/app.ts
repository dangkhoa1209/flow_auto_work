import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getRequestListener } from "@hono/node-server";
import express, { type Express, type Request, type Response } from "express";
import { Hono } from "hono";
import { createApiRoutes } from "./api/routes.js";
import { eventsController } from "./api/controllers/eventsController.js";
import { globalErrorHandler } from "./api/middleware/errorHandler.js";
import { applyGlobalMiddleware } from "./api/middleware/security.js";
import { requireWorkspace } from "./api/middleware/workspaceAuth.js";
import { jobController } from "./api/controllers/jobController.js";
import { getConfig } from "./config.js";

/**
 * Express application factory (transport layer only).
 *
 * Layering:
 * - Routes → Controllers → Services (queue / job-store / agent unchanged)
 * - Legacy Hono `/api/*` handlers are bridged via getRequestListener until
 *   each domain is moved to Express controllers (jobs list/start + SSE already are).
 */
export function createApp(): Express {
  const app = express();

  // —— Global middleware (helmet, cors, morgan, rate-limit) ——
  // Do NOT parse JSON globally: Express consumes the body stream and the Hono
  // bridge would then see empty bodies (login → "username required").
  applyGlobalMiddleware(app);

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      teamsEnabled: getConfig().teamsEnabled,
      ui: "/",
      transport: "express",
    });
  });

  // —— Express-native API (layered) ——
  // SSE must not go through the Hono bridge (different streaming model).
  app.get("/api/events", eventsController.stream);

  // Sample migrated domain — register exact paths so other /api/jobs/* still
  // reach the Hono bridge with an unconsumed body stream.
  const jsonParser = express.json({ limit: "100mb" });
  app.get("/api/jobs", requireWorkspace, jobController.list);
  app.post(
    "/api/jobs/start",
    jsonParser,
    requireWorkspace,
    jobController.start,
  );

  // —— Legacy Hono API bridge (auth, tasks, remaining job routes, workspace) ——
  const legacyHono = new Hono();
  legacyHono.route("/", createApiRoutes());
  const legacyListener = getRequestListener(legacyHono.fetch);

  app.use("/api", (req: Request, res: Response, next) => {
    // SSE is Express-native only
    if (req.path === "/events") {
      next();
      return;
    }

    // Node IncomingMessage.url is path+query; Express may strip mount prefix.
    // Hono createApiRoutes expects paths like /status, /jobs/:id (no /api prefix).
    const originalUrl = req.originalUrl || req.url;
    const pathWithQuery = originalUrl.startsWith("/api")
      ? originalUrl.slice("/api".length) || "/"
      : originalUrl;
    const prevUrl = req.url;
    req.url = pathWithQuery.startsWith("/") ? pathWithQuery : `/${pathWithQuery}`;
    legacyListener(req, res);
    req.url = prevUrl;
  });

  // —— Static UI (Vue dist or legacy public) ——
  const vueDist = join(process.cwd(), "web", "dist");
  const useVue = existsSync(join(vueDist, "index.html"));
  const staticRoot = useVue
    ? join(process.cwd(), "web", "dist")
    : join(process.cwd(), "public");

  // Hashed Vite assets: long cache. Missing files must 404 (not SPA HTML).
  app.use(
    "/assets",
    express.static(join(staticRoot, "assets"), {
      fallthrough: false,
      maxAge: "1y",
      immutable: true,
    }),
  );

  app.use(
    express.static(staticRoot, {
      index: false,
      // index.html + logo/favicon: always revalidate after rebuild
      setHeaders(res, filePath) {
        if (filePath.endsWith("index.html")) {
          res.setHeader("Cache-Control", "no-cache");
        }
      },
    }),
  );

  if (useVue) {
    // SPA fallback — never for missing JS/CSS (would break dynamic import)
    app.get("/{*splat}", async (req, res, next) => {
      const p = req.path || "";
      if (
        p.startsWith("/assets/") ||
        p.startsWith("/api/") ||
        /\.(js|css|map|svg|png|ico|woff2?)$/i.test(p)
      ) {
        next();
        return;
      }
      try {
        res.setHeader("Cache-Control", "no-cache");
        const html = await readFile(join(vueDist, "index.html"), "utf8");
        res.type("html").send(html);
      } catch {
        res
          .status(503)
          .type("text")
          .send("UI not built — run npm run build:web");
      }
    });
  }

  // —— Global error handler (must be last) ——
  app.use(globalErrorHandler);

  return app;
}
