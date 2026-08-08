import { AsyncLocalStorage } from "node:async_hooks";
import type { NextFunction, Request, Response } from "express";
import { getUserByUsername } from "../../workspace/store.js";
import {
  normalizeUserRoles,
  userHasRole,
  type UserRole,
} from "../../workspace/types.js";
import { verifyAccessToken } from "../../auth/tokens.js";
import { AppError } from "../../utils/AppError.js";
import { asyncHandler } from "../../utils/asyncHandler.js";

export type QcRequestContext = {
  username: string;
  roles: UserRole[];
  /** Present when X-Qc-Project sent; may be empty on project-list routes */
  qcProjectId: string;
};

const qcAls = new AsyncLocalStorage<QcRequestContext>();

export function getQcContext(): QcRequestContext | undefined {
  return qcAls.getStore();
}

export function requireQcContext(): QcRequestContext {
  const ctx = qcAls.getStore();
  if (!ctx) {
    throw new AppError("QC context missing — requireQc not applied", 500);
  }
  return ctx;
}

export function headerQcProjectFromExpress(req: Request): string {
  return (
    (req.get("X-Qc-Project") || "").trim() ||
    String(req.query.qcProject || "").trim()
  );
}

/**
 * “I am QC” gate: Bearer JWT + user.roles includes `qc`.
 * Does not bind GitLab workspace. Sets AsyncLocalStorage QC context.
 */
export const requireQc = asyncHandler(
  async (req: Request, _res: Response, next: NextFunction) => {
    const bearer = (req.get("Authorization") || "").trim();
    if (!bearer.toLowerCase().startsWith("bearer ")) {
      throw new AppError("Bearer access token required", 401, "unauthorized");
    }
    let username = "";
    try {
      username = verifyAccessToken(bearer.slice(7).trim()).sub;
    } catch (err) {
      throw new AppError(
        err instanceof Error ? err.message : "Invalid or expired access token",
        401,
        "access_expired",
      );
    }
    if (!username) {
      throw new AppError("Bearer access token required", 401, "unauthorized");
    }

    const user = await getUserByUsername(username);
    if (!user) {
      throw new AppError("User not found — login first", 404);
    }
    if (!userHasRole(user, "qc")) {
      throw new AppError(
        "QC role required — enable “I am QC” in account settings",
        403,
        "qc_forbidden",
      );
    }

    const ctx: QcRequestContext = {
      username: user.id,
      roles: normalizeUserRoles(user.roles),
      qcProjectId: headerQcProjectFromExpress(req),
    };

    qcAls.run(ctx, () => {
      next();
    });
  },
);

/** Require X-Qc-Project after requireQc. */
export const requireQcProject = asyncHandler(
  async (_req: Request, _res: Response, next: NextFunction) => {
    const ctx = requireQcContext();
    if (!ctx.qcProjectId) {
      throw new AppError(
        "X-Qc-Project header required",
        400,
        "qc_project_required",
      );
    }
    next();
  },
);
