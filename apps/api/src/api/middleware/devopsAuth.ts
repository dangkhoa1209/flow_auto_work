import { AsyncLocalStorage } from "node:async_hooks";
import type { NextFunction, Request, Response } from "express";
import { getUserByUsername } from "../../workspace/store.js";
import {
  canAccessDevops,
  normalizeUserRoles,
  type UserRole,
} from "../../workspace/types.js";
import { verifyAccessToken } from "../../auth/tokens.js";
import { AppError } from "../../utils/AppError.js";
import { asyncHandler } from "../../utils/asyncHandler.js";

export type DevopsRequestContext = {
  username: string;
  roles: UserRole[];
};

const devopsAls = new AsyncLocalStorage<DevopsRequestContext>();

export function getDevopsContext(): DevopsRequestContext | undefined {
  return devopsAls.getStore();
}

export function requireDevopsContext(): DevopsRequestContext {
  const ctx = devopsAls.getStore();
  if (!ctx) {
    throw new AppError("Devops context missing — requireDevops not applied", 500);
  }
  return ctx;
}

function tokenFromRequest(req: Request): string {
  const bearer = (req.get("Authorization") || "").trim();
  if (bearer.toLowerCase().startsWith("bearer ")) {
    return bearer.slice(7).trim();
  }
  return String(req.query.access_token || "").trim();
}

/**
 * Devops console gate: Bearer JWT (or access_token query for EventSource) +
 * user.roles includes devops, dev, or admin.
 */
export const requireDevops = asyncHandler(
  async (req: Request, _res: Response, next: NextFunction) => {
    const token = tokenFromRequest(req);
    if (!token) {
      throw new AppError("Bearer access token required", 401, "unauthorized");
    }
    let username = "";
    try {
      username = verifyAccessToken(token).sub;
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
    const roles = normalizeUserRoles(user.roles);
    if (!canAccessDevops(roles)) {
      throw new AppError(
        "Devops role required",
        403,
        "devops_forbidden",
      );
    }
    devopsAls.run({ username: user.id, roles }, () => next());
  },
);
