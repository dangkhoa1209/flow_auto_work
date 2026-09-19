import cors from "cors";
import type { Express, Request } from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import morgan from "morgan";
import { getConfig } from "../../config.js";
import { attachResponseFormatter } from "../../plugins/response-formatter/middleware.js";

/**
 * Global security / ops middlewares for the Express transport layer.
 * Order: formatter → helmet → cors → logger → (body parsers in app.ts) → rate limit.
 */
export function applyGlobalMiddleware(app: Express): void {
  const config = getConfig();

  app.use(attachResponseFormatter);

  // Security headers (CSP relaxed for Vue SPA served from same origin)
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
    }),
  );

  // Allowlist only — credentials: true cannot use "*". Origins from CORS_ORIGINS / config.corsOrigins.
  app.use(
    cors({
      origin(origin, callback) {
        // Same-origin / curl / non-browser: no Origin header
        if (!origin) {
          callback(null, true);
          return;
        }
        callback(null, config.corsOrigins.includes(origin));
      },
      credentials: true,
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: [
        "Content-Type",
        "Authorization",
        "X-Flow-User",
        "X-Flow-Project",
        "X-Qc-Project",
      ],
    }),
  );

  // Request logging
  app.use(morgan(config.isProd ? "combined" : "dev"));

  // Basic anti-spam (skip health + long-lived SSE)
  if (config.rateLimitMax > 0) {
    app.use(
      "/api",
      rateLimit({
        windowMs: config.rateLimitWindowMs,
        max: config.rateLimitMax,
        standardHeaders: true,
        legacyHeaders: false,
        message: {
          success: false,
          error: "Too many requests — slow down",
          code: "rate_limited",
        },
        skip: (req: Request) => {
          const p = req.path || "";
          return (
            p === "/events" ||
            p.startsWith("/events?") ||
            p === "/devops/events" ||
            p === "/ba/sync-db/events" ||
            p.endsWith("/stream")
          );
        },
      }),
    );
  }
}
