import { createRouter, createWebHistory } from "vue-router";
import { useSessionStore } from "@/stores/session";

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
      ],
    },
    {
      path: "/admin",
      component: () => import("@/layouts/AdminLayout.vue"),
      meta: { requiresAdmin: true },
      children: [
        {
          path: "",
          name: "admin",
          component: () => import("@/views/admin/AdminProjectsView.vue"),
        },
        {
          path: "cursor",
          name: "admin-cursor",
          component: () => import("@/views/admin/AdminCursorView.vue"),
        },
        {
          path: "task-types",
          name: "admin-task-types",
          component: () => import("@/views/admin/AdminTaskTypesView.vue"),
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
          path: "qc",
          name: "qc",
          component: () => import("@/views/QcView.vue"),
          meta: { requiresQc: true },
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
              path: "cursor",
              name: "settings-cursor",
              component: () => import("@/views/settings/CursorSettings.vue"),
            },
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

  if (to.meta.public) {
    if (session.isLoggedIn && to.name === "login") {
      const raw = to.query.redirect;
      const path = Array.isArray(raw) ? raw[0] : raw;
      if (
        typeof path === "string" &&
        path.startsWith("/") &&
        !path.startsWith("//") &&
        !path.startsWith("/login")
      ) {
        return path;
      }
      return session.homeRoute;
    }
    return true;
  }
  if (!session.isLoggedIn) {
    return { name: "login", query: { redirect: to.fullPath } };
  }

  if (to.meta.requiresAdmin && !session.isAdmin) {
    return session.homeRoute;
  }
  if (to.meta.requiresBa) {
    if (!(session.isBaAudience || session.isAdmin)) {
      return session.homeRoute;
    }
  }
  if (to.meta.requiresDev) {
    if (session.isBaAudience) {
      return { name: "ba-chat" };
    }
    if (session.isAdmin && !to.path.startsWith("/settings")) {
      // Admin should use Admin / BA, not WorkBench (except we block entirely)
      return { name: "admin" };
    }
  }
  if (to.meta.requiresQc && !session.isQc) {
    return { name: "settings-account" };
  }
  return true;
});

if (typeof window !== "undefined") {
  window.addEventListener("flow:session-expired", () => {
    const session = useSessionStore();
    session.handleSessionExpired();
    if (router.currentRoute.value.name !== "login") {
      void router.push({ name: "login" });
    }
  });
}

export default router;
