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
      path: "/",
      component: () => import("@/layouts/AppLayout.vue"),
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
      return { name: "work" };
    }
    return true;
  }
  if (!session.isLoggedIn) {
    return { name: "login", query: { redirect: to.fullPath } };
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
