import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import express, { type Express } from "express";
import { createApiRouter } from "./api/routes/index.js";
import { eventsController } from "./api/controllers/eventsController.js";
import { globalErrorHandler } from "./api/middleware/errorHandler.js";
import { applyGlobalMiddleware } from "./api/middleware/security.js";

/**
 * Express application factory (transport layer only).
 *
 * Layering: Routes → Controllers → Modules
 * Routes under /api are auto-mounted via processRoutePath.
 */
export async function createApp(): Promise<Express> {
  const app = express();

  applyGlobalMiddleware(app);

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      ui: "/",
      transport: "express",
    });
  });

  app.get("/api/events", eventsController.stream);

  app.use("/api", express.json({ limit: "100mb" }), await createApiRouter());

  const vueDist = join(process.cwd(), "web", "dist");
  const useVue = existsSync(join(vueDist, "index.html"));
  const staticRoot = useVue
    ? join(process.cwd(), "web", "dist")
    : join(process.cwd(), "public");

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
      setHeaders(res, filePath) {
        if (filePath.endsWith("index.html")) {
          res.setHeader("Cache-Control", "no-cache");
        }
      },
    }),
  );

  if (useVue) {
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

  app.use(globalErrorHandler);

  return app;
}
