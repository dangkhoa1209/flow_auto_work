import { createRouter, createWebHistory } from "vue-router";
import { getRefreshToken } from "@/api/tokenStorage";
import { useAuthStore } from "@/stores/auth";
import { useSessionStore } from "@/stores/session";
import { isPathAllowed, isRouteAllowed, resolveHomeRoute } from "@/utils/routeAccess";
import { reloadOnChunkError } from "@/utils/reloadOnChunkError";

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: "/login",
      name: "login",
      component: () => import("@/views/LoginView.vue"),
      meta: { public: true },
    },
    {
      path: "/ba",
      component: () => import("@/layouts/BaLayout.vue"),
      meta: { requiresBa: true },
      children: [
        {
          path: "",
          name: "ba-chat",
          component: () => import("@/views/BaChatView.vue"),
        },
        {
          path: "workflow",
          name: "ba-workflow",
          component: () => import("@/views/BaWorkflowView.vue"),
        },
        {
          path: "tasks",
          name: "ba-tasks",
          component: () => import("@/views/BaTasksView.vue"),
        },
        {
          path: "settings",
          component: () => import("@/layouts/BaSettingsLayout.vue"),
          children: [
            { path: "", redirect: "/ba/settings/gitlab" },
            {
              path: "gitlab",
              name: "ba-settings-gitlab",
              component: () =>
                import("@/views/ba/settings/BaGitPatSettings.vue"),
            },
            {
              path: "google",
              name: "ba-settings-google",
              component: () =>
                import("@/views/ba/settings/BaGoogleSettings.vue"),
            },
            {
              path: "account",
              name: "ba-settings-account",
              component: () => import("@/views/settings/AccountSettings.vue"),
            },
          ],
        },
      ],
    },
    {
      path: "/devops",
      component: () => import("@/layouts/DevopsLayout.vue"),
      meta: { requiresDevops: true },
      children: [
        {
          path: "",
          name: "devops",
          component: () => import("@/views/DevopsView.vue"),
        },
        {
          path: "settings",
          component: () => import("@/layouts/DevopsSettingsLayout.vue"),
          children: [
            { path: "", redirect: "/devops/settings/account" },
            {
              path: "account",
              name: "devops-settings-account",
              component: () => import("@/views/settings/AccountSettings.vue"),
            },
          ],
        },
      ],
    },
    {
      path: "/admin",
      component: () => import("@/layouts/AdminLayout.vue"),
      meta: { requiresAdmin: true },
      children: [
        {
          path: "",
          redirect: { name: "admin-users" },
        },
        {
          path: "users",
          name: "admin-users",
          component: () => import("@/views/admin/AdminUsersView.vue"),
        },
        {
          path: "usage",
          name: "admin-usage",
          component: () => import("@/views/admin/AdminCursorUsageView.vue"),
        },
        {
          path: "chatbox",
          name: "admin",
          component: () => import("@/views/admin/AdminProjectsView.vue"),
        },
        {
          path: "ai-engine",
          name: "admin-ai-engine",
          component: () => import("@/views/admin/AdminCursorView.vue"),
        },
        {
          path: "cursor",
          redirect: { name: "admin-ai-engine" },
        },
        {
          path: "task-types",
          name: "admin-task-types",
          component: () => import("@/views/admin/AdminTaskTypesView.vue"),
        },
        {
          path: "ba-features",
          name: "admin-ba-features",
          component: () => import("@/views/admin/AdminBaFeaturesView.vue"),
        },
        {
          path: "settings",
          component: () => import("@/layouts/AdminSettingsLayout.vue"),
          children: [
            { path: "", redirect: "/admin/settings/account" },
            {
              path: "account",
              name: "admin-settings-account",
              component: () => import("@/views/settings/AccountSettings.vue"),
            },
          ],
        },
      ],
    },
    {
      path: "/",
      component: () => import("@/layouts/AppLayout.vue"),
      meta: { requiresDev: true },
      children: [
        { path: "", redirect: "/work" },
        {
          path: "work",
          name: "work",
          component: () => import("@/views/WorkView.vue"),
        },
        {
          path: "handoff",
          name: "handoff",
          component: () => import("@/views/HandoffView.vue"),
        },
        {
          path: "stats",
          name: "stats",
          component: () => import("@/views/StatsView.vue"),
        },
        {
          path: "settings",
          component: () => import("@/layouts/SettingsLayout.vue"),
          children: [
            { path: "", redirect: "/settings/project" },
            {
              path: "account",
              name: "settings-account",
              component: () => import("@/views/settings/AccountSettings.vue"),
            },
            {
              path: "project",
              name: "settings-project",
              component: () => import("@/views/settings/ProjectSettings.vue"),
            },
            {
              path: "integrations",
              name: "settings-integrations",
              component: () =>
                import("@/views/settings/IntegrationsSettings.vue"),
            },
            {
              path: "ai-engine",
              name: "settings-ai-engine",
              component: () => import("@/views/settings/AiEngineSettings.vue"),
            },
            { path: "cursor", redirect: "/settings/ai-engine" },
            {
              path: "labels",
              name: "settings-labels",
              component: () => import("@/views/settings/LabelsSettings.vue"),
            },
          ],
        },
      ],
    },
  ],
});

router.beforeEach(async (to) => {
  const session = useSessionStore();
  if (!session.bootstrapped) await session.bootstrap();

  if (session.isLoggedIn && !session.me) {
    try {
      await session.refreshMe();
    } catch (err) {
      const status =
        err && typeof err === "object" && "status" in err
          ? Number((err as { status?: number }).status)
          : 0;
      // Network/5xx: stay on route and let UI retry. Only hard auth loss → login.
      if (status === 401) {
        // Access may be expired — try refresh before forcing logout.
        const ok = await useAuthStore().refresh();
        if (ok) {
          try {
            await session.refreshMe();
            // continue navigation below
          } catch {
            if (!getRefreshToken()) {
              await session.logout();
              return { name: "login" };
            }
          }
        } else if (!getRefreshToken()) {
          await session.logout();
          return { name: "login" };
        }
      }
    }
  }

  const access = {
    isAdmin: session.isAdmin,
    isDevopsAudience: session.isDevopsAudience,
    canAccessWork: session.canAccessWork,
    canAccessBa: session.canAccessBa,
    canAccessDevops: session.canAccessDevops,
  };

  if (to.meta.public) {
    if (session.isLoggedIn && to.name === "login") {
      const raw = to.query.redirect;
      const path = Array.isArray(raw) ? raw[0] : raw;
      if (
        typeof path === "string" &&
        path.startsWith("/") &&
        !path.startsWith("//") &&
        !path.startsWith("/login") &&
        isPathAllowed(path, access)
      ) {
        return path;
      }
      const home = resolveHomeRoute(access);
      if (home === "/login") {
        // No capability yet (me not loaded) — stay on login without wiping
        // refresh tokens (mobile wake used to false-logout here).
        return true;
      }
      return home;
    }
    return true;
  }
  if (!session.isLoggedIn) {
    return { name: "login", query: { redirect: to.fullPath } };
  }

  if (!isRouteAllowed(to, access)) {
    const home = resolveHomeRoute(access);
    if (home === "/login") {
      return { name: "login", query: { error: "no_access" } };
    }
    if (to.path === home) {
      return true;
    }
    return home;
  }
  return true;
});

router.onError((err) => {
  reloadOnChunkError(err);
});

if (typeof window !== "undefined") {
  window.addEventListener("flow:session-expired", () => {
    // Re-login may have restored tokens after a stale expire event was queued.
    if (getRefreshToken()) return;
    if (router.currentRoute.value.name !== "login") {
      void router.push({ name: "login" });
    }
  });
}

export default router;
