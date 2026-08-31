import { AsyncLocalStorage } from "node:async_hooks";
import type { NextFunction, Request, Response } from "express";
import { getUserByUsername } from "../../workspace/store.js";
import {
  canAccessBa,
  isAdminRole,
  isBaAudience,
  normalizeUserRoles,
  type UserRole,
} from "../../workspace/types.js";
import { verifyAccessToken } from "../../auth/tokens.js";
import { AppError } from "../../utils/AppError.js";
import { asyncHandler } from "../../utils/asyncHandler.js";

export type RoleRequestContext = {
  username: string;
  roles: UserRole[];
};

const roleAls = new AsyncLocalStorage<RoleRequestContext>();

export function getRoleContext(): RoleRequestContext | undefined {
  return roleAls.getStore();
}

export function requireRoleContext(): RoleRequestContext {
  const ctx = roleAls.getStore();
  if (!ctx) {
    throw new AppError("Role context missing", 500);
  }
  return ctx;
}

async function resolveBearerUser(req: Request): Promise<{
  username: string;
  roles: UserRole[];
}> {
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
  return { username: user.id, roles: normalizeUserRoles(user.roles) };
}

/** Admin-only gate for /api/admin/* */
export const requireAdmin = asyncHandler(
  async (req: Request, _res: Response, next: NextFunction) => {
    const { username, roles } = await resolveBearerUser(req);
    if (!isAdminRole(roles)) {
      throw new AppError("Admin role required", 403, "admin_forbidden");
    }
    roleAls.run({ username, roles }, () => next());
  },
);

/**
 * BA Chat gate: ba | pd | qc | dev | devops | admin.
 */
export const requireBa = asyncHandler(
  async (req: Request, _res: Response, next: NextFunction) => {
    const { username, roles } = await resolveBearerUser(req);
    if (!canAccessBa(roles)) {
      throw new AppError(
        "BA Chat role required (ba, pd, qc, dev, devops, or admin)",
        403,
        "ba_forbidden",
      );
    }
    roleAls.run({ username, roles }, () => next());
  },
);
