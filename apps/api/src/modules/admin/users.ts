import { revokeAllRefreshSessions } from "../../auth/sessions.js";
import { generateTemporaryPassword } from "../../auth/password.js";
import {
  AUTH_USERNAME_HINT,
  isValidAuthUsername,
  normalizeAuthUsername,
} from "../../auth/username.js";
import {
  adminCreateUser,
  adminPurgeUser,
  adminResetUserPassword,
  adminSetUserDisabled,
  adminUpdateUser,
  getUserForAdmin,
  listUsersForAdmin,
} from "../../workspace/store.js";
import {
  ALL_USER_ROLES,
  isRootAdminUsername,
  normalizeUserRoles,
  type UserRole,
} from "../../workspace/types.js";
import { AppError } from "../../utils/AppError.js";
import { requireRoleContext } from "../../api/middleware/roleAuth.js";

function parseSingleRole(raw: unknown, field = "role"): UserRole | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (Array.isArray(raw)) {
    if (raw.length === 0) return undefined;
    if (raw.length > 1) {
      throw new AppError("Select only one role", 400);
    }
    return parseSingleRole(raw[0], field);
  }
  const r = String(raw).trim().toLowerCase();
  if (!ALL_USER_ROLES.includes(r as UserRole)) {
    throw new AppError(
      `Invalid ${field}: ${r}. Allowed: ${ALL_USER_ROLES.join(", ")}`,
      400,
    );
  }
  return r as UserRole;
}

function parseRoles(raw: unknown): UserRole[] | undefined {
  const one = parseSingleRole(raw, "role");
  if (one === undefined) return undefined;
  return normalizeUserRoles([one]);
}

function assertNotRootAdmin(targetId: string, action: string): void {
  if (isRootAdminUsername(targetId)) {
    throw new AppError(
      `Cannot ${action} the root admin account`,
      403,
      "root_admin_protected",
    );
  }
}

function assertNotSelf(targetId: string, action: string): void {
  const actor = requireRoleContext().username;
  if (normTarget(actor) === normTarget(targetId)) {
    throw new AppError(`Cannot ${action} your own account`, 400);
  }
}

function normTarget(username: string): string {
  return normalizeAuthUsername(username);
}

export async function adminListUsers() {
  return { users: await listUsersForAdmin() };
}

export async function adminGetUser(id: string) {
  const user = await getUserForAdmin(id);
  if (!user) throw new AppError("User not found", 404);
  return { user };
}

export async function adminCreateUserHandler(body: {
  username?: string;
  password?: string;
  displayName?: string;
  role?: unknown;
  roles?: unknown;
}) {
  const username = normalizeAuthUsername(body.username || "");
  if (!username) throw new AppError("username required", 400);
  if (!isValidAuthUsername(username)) {
    throw new AppError(AUTH_USERNAME_HINT, 400);
  }
  if (isRootAdminUsername(username)) {
    throw new AppError("Username “admin” is reserved for the root account", 409);
  }
  const generatedPassword =
    body.password?.trim() || generateTemporaryPassword();
  if (generatedPassword.length < 6) {
    throw new AppError("Password must be at least 6 characters", 400);
  }
  const roleRaw = body.role ?? body.roles;
  try {
    const user = await adminCreateUser({
      username,
      password: generatedPassword,
      displayName: body.displayName?.trim() || username,
      roles: parseRoles(roleRaw) ?? ["dev"],
    });
    return { user, generatedPassword };
  } catch (err) {
    throw new AppError(err instanceof Error ? err.message : String(err), 400);
  }
}

export async function adminUpdateUserHandler(
  id: string,
  body: { displayName?: string; role?: unknown; roles?: unknown },
) {
  const username = normTarget(id);
  assertNotRootAdmin(username, "edit");
  const roleRaw = body.role ?? body.roles;
  try {
    const user = await adminUpdateUser({
      username,
      displayName: body.displayName,
      roles: parseRoles(roleRaw),
    });
    return { user };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new AppError(msg, msg === "User not found" ? 404 : 400);
  }
}

export async function adminDisableUser(id: string) {
  const username = normTarget(id);
  assertNotRootAdmin(username, "disable");
  assertNotSelf(username, "disable");
  try {
    const user = await adminSetUserDisabled(username, true);
    await revokeAllRefreshSessions(username);
    return { user };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new AppError(msg, msg === "User not found" ? 404 : 400);
  }
}

export async function adminEnableUser(id: string) {
  const username = normTarget(id);
  try {
    const user = await adminSetUserDisabled(username, false);
    return { user };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new AppError(msg, msg === "User not found" ? 404 : 400);
  }
}

export async function adminDeleteUser(id: string) {
  const username = normTarget(id);
  assertNotRootAdmin(username, "delete");
  assertNotSelf(username, "delete");
  try {
    await adminPurgeUser(username);
    await revokeAllRefreshSessions(username);
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new AppError(msg, msg === "User not found" ? 404 : 400);
  }
}

export async function adminResetPasswordHandler(
  id: string,
  _body: { newPassword?: string },
) {
  const username = normTarget(id);
  assertNotRootAdmin(username, "reset password");
  const generatedPassword = generateTemporaryPassword();
  try {
    const user = await adminResetUserPassword({
      username,
      newPassword: generatedPassword,
    });
    await revokeAllRefreshSessions(username);
    return { user, generatedPassword };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new AppError(msg, msg === "User not found" ? 404 : 400);
  }
}
