import type { RouteLocationNormalized } from "vue-router";

type SessionAccess = {
  isAdmin: boolean;
  isDevopsAudience: boolean;
  canAccessWork: boolean;
  canAccessBa: boolean;
  canAccessDevops: boolean;
};

/** First route the user is allowed to land on after login. */
export function resolveHomeRoute(session: SessionAccess): string {
  if (session.isAdmin) return "/admin/users";
  if (session.canAccessWork) return "/work";
  if (session.isDevopsAudience) return "/devops";
  if (session.canAccessBa) return "/ba";
  if (session.canAccessDevops) return "/devops";
  return "/login";
}

export function isRouteAllowed(
  to: RouteLocationNormalized,
  session: SessionAccess,
): boolean {
  if (to.meta.requiresAdmin && !session.isAdmin) return false;
  if (to.meta.requiresDevops && !session.canAccessDevops) return false;
  if (to.meta.requiresBa && !session.canAccessBa) return false;
  if (to.meta.requiresDev && !session.canAccessWork) return false;
  if (
    to.meta.requiresDev &&
    session.isAdmin &&
    !to.path.startsWith("/settings")
  ) {
    return false;
  }
  return true;
}

/** Check a path string (e.g. login redirect query) without full route meta. */
export function isPathAllowed(path: string, session: SessionAccess): boolean {
  if (path.startsWith("/admin")) return session.isAdmin;
  if (path.startsWith("/devops")) return session.canAccessDevops;
  if (path.startsWith("/ba")) return session.canAccessBa;
  if (
    path.startsWith("/work") ||
    path.startsWith("/handoff") ||
    path.startsWith("/stats") ||
    path.startsWith("/settings") ||
    path === "/"
  ) {
    if (session.isAdmin && !path.startsWith("/settings")) return false;
    return session.canAccessWork;
  }
  return false;
}
