import type { NextFunction, Request, Response } from "express";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { AppError } from "../../utils/AppError.js";
import {
  resolveRuntimeContext,
} from "../../workspace/resolve.js";
import { runWithRuntimeContext } from "../../workspace/runtime.js";
import { verifyAccessToken } from "../../auth/tokens.js";

/** Paths under /api (relative) that skip project workspace binding */
function isPublicApiPath(path: string): boolean {
  if (path === "/status" || path === "/events" || path === "/context") {
    return true;
  }
  if (path === "/me" || path.startsWith("/me/")) return true;
  if (path.startsWith("/auth/")) return true;
  if (path.startsWith("/projects/")) return true;
  if (path.startsWith("/gitlab/")) return true;
  return false;
}

export function headerUserFromExpress(req: Request): string {
  const bearer = (req.get("Authorization") || "").trim();
  if (bearer.toLowerCase().startsWith("bearer ")) {
    const token = bearer.slice(7).trim();
    if (token) {
      try {
        return verifyAccessToken(token).sub;
      } catch {
        /* fall through */
      }
    }
  }
  const qAccess = String(req.query.access_token || "").trim();
  if (qAccess) {
    try {
      return verifyAccessToken(qAccess).sub;
    } catch {
      /* fall through */
    }
  }
  return (req.get("X-Flow-User") || "").trim().replace(/^@/, "");
}

export function headerProjectFromExpress(req: Request): string {
  return (
    (req.get("X-Flow-Project") || "").trim() ||
    String(req.query.project || "").trim()
  );
}

/**
 * Bind workspace secrets into AsyncLocalStorage for the rest of this request.
 * Call next() inside `als.run` so async controllers still see the store.
 */
export function requireWorkspace(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  void (async () => {
    try {
      if (isPublicApiPath(req.path)) {
        next();
        return;
      }

      const bearer = (req.get("Authorization") || "").trim();
      let username = "";
      if (bearer.toLowerCase().startsWith("bearer ")) {
        try {
          username = verifyAccessToken(bearer.slice(7).trim()).sub;
        } catch (err) {
          next(
            new AppError(
              err instanceof Error
                ? err.message
                : "Invalid or expired access token",
              401,
              "access_expired",
            ),
          );
          return;
        }
      }
      if (!username) username = headerUserFromExpress(req);
      const projectId = headerProjectFromExpress(req);
      if (!username || !projectId) {
        next(
          new AppError(
            "Bearer access token + X-Flow-Project required — login and select a project",
            401,
            "unauthorized",
          ),
        );
        return;
      }

      const ctx = await resolveRuntimeContext({
        gitlabUsername: username,
        projectId,
      });
      // Keep ALS active across async route handlers started by next()
      runWithRuntimeContext(ctx, () => {
        next();
      });
    } catch (err) {
      next(
        err instanceof AppError
          ? err
          : new AppError(
              err instanceof Error ? err.message : String(err),
              401,
            ),
      );
    }
  })();
}

/** Optional: wrap only specific routers */
export const requireWorkspaceAsync = asyncHandler(
  async (req, res, next) => {
    requireWorkspace(req, res, next);
  },
);
