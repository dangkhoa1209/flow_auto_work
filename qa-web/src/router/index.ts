import { createRouter, createWebHistory } from "vue-router";
import { getAccessToken, loadPersistedAuth } from "@/api/tokenStorage";

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: "/login",
      name: "login",
      component: () => import("@/views/LoginView.vue"),
    },
    {
      path: "/",
      component: () => import("@/layouts/AppLayout.vue"),
      meta: { auth: true },
      children: [
        { path: "", redirect: "/trigger" },
        {
          path: "config",
          name: "config",
          component: () => import("@/views/ConfigView.vue"),
        },
        {
          path: "trigger",
          name: "trigger",
          component: () => import("@/views/TriggerView.vue"),
        },
        {
          path: "review/:id?",
          name: "review",
          component: () => import("@/views/ReviewView.vue"),
        },
      ],
    },
  ],
});

router.beforeEach((to) => {
  if (!to.meta.auth) return true;
  const ok = Boolean(getAccessToken() || loadPersistedAuth().refreshToken);
  if (!ok) return { name: "login", query: { redirect: to.fullPath } };
  return true;
});

export default router;
