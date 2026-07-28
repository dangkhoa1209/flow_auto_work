import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { qaApi } from "@/api/qaApi";
import { useAuthStore } from "@/stores/auth";
import { refreshAccessTokenRaw } from "@/api/http";
import {
  getAccessToken,
  getRefreshToken,
  loadPersistedAuth,
  savePersistedAuth,
} from "@/api/tokenStorage";

export type Membership = {
  projectId: string;
  project?: { id: string; displayName?: string; gitlabPath?: string };
};

/**
 * Workspace / project session — tokens live in useAuthStore.
 * QA APIs require Bearer + X-Flow-Project; wait for `ready` before calling them.
 */
export const useSessionStore = defineStore("session", () => {
  const auth = useAuthStore();

  const projectId = ref<string | null>(loadPersistedAuth().projectId);
  const memberships = ref<Membership[]>([]);
  const bootstrapped = ref(false);
  const bootError = ref<string | null>(null);

  const isAuthenticated = computed(() => auth.isAuthenticated);
  const username = computed(() => auth.username);

  /** Safe to call /api/qa/* (token in memory + project selected). */
  const ready = computed(
    () =>
      bootstrapped.value &&
      Boolean(getAccessToken() || auth.accessToken) &&
      Boolean(projectId.value),
  );

  const session = computed({
    get: () => ({
      username: auth.username,
      projectId: projectId.value,
      accessToken: auth.accessToken,
      refreshToken: auth.refreshToken,
    }),
    set: (next: {
      username?: string | null;
      projectId?: string | null;
    }) => {
      if (next.username !== undefined) auth.setUsername(next.username);
      if (next.projectId !== undefined) {
        projectId.value = next.projectId;
        auth.setProjectId(next.projectId);
      }
    },
  });

  function normalizeMemberships(list: Membership[] | undefined | null) {
    return (list || [])
      .map((m) => ({
        ...m,
        projectId: String(m.projectId || m.project?.id || "").trim(),
        project: m.project,
      }))
      .filter((m) => Boolean(m.projectId));
  }

  function setMemberships(list: Membership[] | undefined | null) {
    memberships.value = normalizeMemberships(list);
  }

  function setSession(opts: {
    username?: string | null;
    projectId?: string | null;
  }) {
    session.value = opts;
  }

  function selectProject(id: string) {
    const pid = id.trim();
    if (!pid) return;
    projectId.value = pid;
    auth.setProjectId(pid);
    savePersistedAuth({ projectId: pid });
  }

  function reconcileProjectId() {
    const pid = projectId.value?.trim() || null;
    if (!pid) {
      const first = memberships.value[0]?.projectId;
      if (first) selectProject(first);
      return;
    }
    if (memberships.value.length === 0) return;
    const ok = memberships.value.some(
      (m) => m.projectId === pid || m.project?.id === pid,
    );
    if (!ok) {
      const next = memberships.value[0]?.projectId;
      if (next) selectProject(next);
    }
  }

  async function ensureAccessToken() {
    auth.syncFromBridge();
    const hasMemory = Boolean(getAccessToken());
    const rt = getRefreshToken();
    if (hasMemory) return true;
    if (!rt) return false;
    await refreshAccessTokenRaw();
    auth.syncFromBridge();
    return Boolean(getAccessToken());
  }

  async function refreshMe() {
    auth.syncFromBridge();
    if (!auth.username && !getAccessToken() && !getRefreshToken()) {
      memberships.value = [];
      return;
    }
    const me = await qaApi.me();
    if (me.user?.gitlabUsername) {
      auth.setUsername(me.user.gitlabUsername);
    }
    setMemberships(me.memberships);
    reconcileProjectId();
    savePersistedAuth({
      username: auth.username,
      projectId: projectId.value,
    });
  }

  async function bootstrap() {
    bootError.value = null;
    bootstrapped.value = false;
    try {
      projectId.value = loadPersistedAuth().projectId;
      auth.hydrate();
      auth.syncFromBridge();

      if (!getRefreshToken() && !getAccessToken()) {
        bootstrapped.value = true;
        return;
      }

      const ok = await ensureAccessToken();
      if (!ok) {
        throw new Error("Session expired — please sign in again");
      }

      await refreshMe();
      bootstrapped.value = true;
    } catch (err) {
      bootError.value = err instanceof Error ? err.message : String(err);
      bootstrapped.value = true;
      throw err;
    }
  }

  async function logout() {
    await auth.logout();
    projectId.value = null;
    memberships.value = [];
    bootstrapped.value = false;
    bootError.value = null;
  }

  return {
    username,
    projectId,
    memberships,
    isAuthenticated,
    session,
    bootstrapped,
    bootError,
    ready,
    setMemberships,
    setSession,
    selectProject,
    refreshMe,
    bootstrap,
    ensureAccessToken,
    logout,
  };
});
