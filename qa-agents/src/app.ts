import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import express, { type Express } from "express";
import { applyGlobalMiddleware } from "../../src/api/middleware/security.js";
import { globalErrorHandler } from "../../src/api/middleware/errorHandler.js";
import { requireWorkspace } from "../../src/api/middleware/workspaceAuth.js";
import { createAuthRoutes } from "../../src/api/routes/authRoutes.js";
import { createProjectRoutes } from "../../src/api/routes/projectRoutes.js";
import { createMeRoutes } from "../../src/api/routes/meRoutes.js";
import { createQaRoutes } from "./api/routes/qaRoutes.js";
import { qaEventsController } from "./api/eventsController.js";
import { jobArtifactsDir } from "./job-store.js";
import { asyncHandler } from "../../src/utils/asyncHandler.js";
import { AppError } from "../../src/utils/AppError.js";

export async function createQaApp(): Promise<Express> {
  const app = express();
  applyGlobalMiddleware(app);

  app.get("/health", (_req, res) => {
    res.json({ ok: true, service: "qa-agents", ui: "/" });
  });

  app.get("/api/events", qaEventsController.stream);

  const api = express.Router();
  api.use(requireWorkspace);
  api.use("/auth", createAuthRoutes());
  api.use("/projects", createProjectRoutes());
  api.use("/me", createMeRoutes());
  api.use("/qa", createQaRoutes());

  // Serve local screenshots for Review UI (before GitLab upload)
  api.get(
    "/qa/artifacts/:jobId/:file",
    asyncHandler(async (req, res) => {
      const jobId = String(req.params.jobId || "");
      const file = String(req.params.file || "");
      if (
        !jobId ||
        !file ||
        file.includes("..") ||
        file.includes("/") ||
        file.includes("\\")
      ) {
        throw new AppError("Invalid artifact path", 400);
      }
      const abs = join(jobArtifactsDir(jobId), file);
      if (!existsSync(abs)) throw new AppError("Not found", 404);
      res.sendFile(abs);
    }),
  );

  app.use("/api", express.json({ limit: "20mb" }), api);

  const vueDist = join(process.cwd(), "qa-web", "dist");
  if (existsSync(join(vueDist, "index.html"))) {
    app.use(express.static(vueDist, { index: false }));
    app.get("/{*splat}", async (req, res, next) => {
      const p = req.path || "";
      if (p.startsWith("/api/") || p.startsWith("/health")) {
        next();
        return;
      }
      try {
        const html = await readFile(join(vueDist, "index.html"), "utf8");
        res.type("html").send(html);
      } catch {
        res
          .status(503)
          .type("text")
          .send("QA UI not built — run npm run build:qa-web");
      }
    });
  }

  app.use(globalErrorHandler);
  return app;
}
