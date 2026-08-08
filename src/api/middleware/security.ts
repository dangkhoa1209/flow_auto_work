import cors from "cors";
import type { Express, Request } from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import morgan from "morgan";
import { getConfig } from "../../config.js";

/**
 * Global security / ops middlewares for the Express transport layer.
 * Order: helmet → cors → logger → (body parsers applied in app.ts) → rate limit.
 */
export function applyGlobalMiddleware(app: Express): void {
  const config = getConfig();

  // Security headers (CSP relaxed for Vue SPA served from same origin)
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
    }),
  );

  // Open CORS (reflect any Origin; required when credentials: true — literal "*" is invalid)
  app.use(
    cors({
      origin: true,
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
          return p === "/events" || p.startsWith("/events?");
        },
      }),
    );
  }
}
