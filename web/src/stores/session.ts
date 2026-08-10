import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { API } from "@/api/endpoints";
import { api } from "@/api/client";
import { useAuthStore } from "@/stores/auth";
import {
  getAccessExpiresAt,
  getAccessToken,
  getRefreshToken,
  loadPersistedAuth,
  savePersistedAuth,
} from "@/api/tokenStorage";

export type Membership = {
  projectId: string;
  baseBranch?: string;
  workBranch?: string;
  project: {
    id: string;
    displayName?: string;
    projectName?: string;
    gitlabPath: string;
    gitlabHost?: string;
    repoPath?: string;
    localPath?: string;
    isActive?: boolean;
    cloneStatus?: string;
    cloneError?: string | null;
    hasGitlabToken?: boolean;
    mainBranch?: string | null;
    workingBranch?: string | null;
  };
};

export type UserPublic = {
  id?: string;
  gitlabUsername?: string;
  username?: string;
  hasCursorApiKey?: boolean;
  hasGitlabToken?: boolean;
  cursorModel?: string;
  roles?: string[];
};

/** Workspace / project session — tokens live in useAuthStore. */
export const useSessionStore = defineStore("session", () => {
  const auth = useAuthStore();

  const projectId = ref<string | null>(loadPersistedAuth().projectId);
  const me = ref<UserPublic | null>(null);
  const memberships = ref<Membership[]>([]);
  const loading = ref(false);
  const bootstrapped = ref(false);

  /** Legacy shape for components still reading session.session */
  const session = computed({
    get: () => ({
      username: auth.username,
      projectId: projectId.value,
      accessToken: auth.accessToken,
      refreshToken: auth.refreshToken,
      accessExpiresAt: auth.accessExpiresAt,
    }),
    set: (next: {
      username?: string | null;
      projectId?: string | null;
      accessToken?: string | null;
      refreshToken?: string | null;
      accessExpiresAt?: number | null;
    }) => {
      if (next.username !== undefined) auth.setUsername(next.username);
      if (next.projectId !== undefined) {
        projectId.value = next.projectId;
        auth.setProjectId(next.projectId);
      }
      if (
        next.accessToken != null &&
        next.refreshToken != null
      ) {
        auth.setTokens({
          accessToken: next.accessToken,
          refreshToken: next.refreshToken,
          accessExpiresAt: next.accessExpiresAt ?? undefined,
          username: next.username ?? auth.username,
          projectId: next.projectId ?? projectId.value,
        });
      }
    },
  });

  const isLoggedIn = computed(() => auth.isAuthenticated);

  const isQc = computed(() => Boolean(me.value?.roles?.includes("qc")));

  const isAdmin = computed(() => Boolean(me.value?.roles?.includes("admin")));

  /** BA / PD / QC-only audience (not Dev+QC toggle). */
  const isBaAudience = computed(() => {
    const roles = me.value?.roles || [];
    if (roles.includes("admin")) return false;
    if (roles.includes("ba") || roles.includes("pd")) return true;
    if (roles.includes("qc") && !roles.includes("dev")) return true;
    return false;
  });

  const homeRoute = computed(() => {
    if (isAdmin.value) return "/admin";
    if (isBaAudience.value) return "/ba";
    return "/work";
  });

  const currentMembership = computed(() =>
    memberships.value.find((m) => m.projectId === projectId.value),
  );

  function persist() {
    savePersistedAuth({
      username: auth.username,
      projectId: projectId.value,
      refreshToken: auth.refreshToken,
    });
  }

  function syncFromStorage() {
    auth.hydrate();
    auth.syncFromBridge();
    projectId.value = loadPersistedAuth().projectId;
  }

  function normalizeMemberships(
    list: Membership[] | undefined | null,
  ): Membership[] {
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

  function reconcileProjectId() {
    const pid = projectId.value;
    if (!pid) {
      const first = memberships.value[0]?.projectId;
      if (first) {
        projectId.value = first;
        auth.setProjectId(first);
      }
      return;
    }
    if (memberships.value.length === 0) return;
    const ok = memberships.value.some(
      (m) => m.projectId === pid || m.project?.id === pid,
    );
    if (!ok) {
      const next = memberships.value[0]?.projectId ?? pid;
      projectId.value = next;
      auth.setProjectId(next);
    }
  }

  async function refreshMe() {
    auth.syncFromBridge();
    if (!auth.username && !getAccessToken() && !getRefreshToken()) {
      me.value = null;
      memberships.value = [];
      return;
    }
    const data = await api<{
      user?: UserPublic;
      memberships?: Membership[];
    }>(API.me.root);
    me.value = data.user ?? null;
    setMemberships(data.memberships);
    if (data.user?.gitlabUsername) {
      auth.setUsername(data.user.gitlabUsername);
    }
    reconcileProjectId();
    persist();
  }

  async function bootstrap() {
    loading.value = true;
    try {
      syncFromStorage();
      if (!auth.refreshToken && !auth.accessToken) {
        return;
      }
      if (
        auth.refreshToken &&
        (!auth.accessToken ||
          (auth.accessExpiresAt &&
            auth.accessExpiresAt < Date.now() + 5_000) ||
          (!getAccessToken() && getRefreshToken()))
      ) {
        const ok = await auth.refresh();
        if (!ok) {
          await logout();
          return;
        }
      }
      await refreshMe();
      syncFromStorage();
    } catch {
      const ok = await auth.refresh();
      if (ok) {
        try {
          await refreshMe();
          return;
        } catch {
          /* fallthrough */
        }
      }
      await logout();
    } finally {
      bootstrapped.value = true;
      loading.value = false;
    }
  }

  function setSession(next: {
    username?: string | null;
    projectId?: string | null;
    accessToken?: string | null;
    refreshToken?: string | null;
    accessExpiresAt?: number | null;
  }) {
    if (next.username !== undefined) auth.setUsername(next.username);
    if (next.projectId !== undefined) {
      projectId.value = next.projectId;
      auth.setProjectId(next.projectId);
    }
    if (next.accessToken && next.refreshToken) {
      auth.setTokens({
        accessToken: next.accessToken,
        refreshToken: next.refreshToken,
        accessExpiresAt: next.accessExpiresAt ?? getAccessExpiresAt() ?? undefined,
        username: next.username ?? auth.username,
        projectId: next.projectId ?? projectId.value,
      });
    }
    persist();
  }

  function setAuthTokens(tokens: {
    accessToken: string;
    refreshToken: string;
    expiresIn?: number;
    accessExpiresAt?: number;
    username?: string;
  }) {
    auth.setTokens({
      ...tokens,
      username: tokens.username ?? auth.username,
      projectId: projectId.value,
    });
  }

  async function logout() {
    await auth.logout();
    projectId.value = null;
    me.value = null;
    memberships.value = [];
  }

  function handleSessionExpired() {
    auth.clearLocal();
    projectId.value = null;
    me.value = null;
    memberships.value = [];
  }

  if (typeof window !== "undefined") {
    window.addEventListener("flow:session-expired", handleSessionExpired);
  }

  async function activateProject(idRaw: string): Promise<void> {
    const id = idRaw.trim();
    if (!id) throw new Error("projectId required");
    const res = await api<{ memberships?: Membership[] }>(
      API.projects.activate(id),
      { method: "POST", body: "{}" },
    );
    if (res.memberships) setMemberships(res.memberships);
    setSession({ projectId: id });
    await refreshMe();
  }

  return {
    session,
    projectId,
    me,
    memberships,
    loading,
    bootstrapped,
    isLoggedIn,
    isQc,
    isAdmin,
    isBaAudience,
    homeRoute,
    currentMembership,
    bootstrap,
    refreshMe,
    setSession,
    setAuthTokens,
    setMemberships,
    activateProject,
    logout,
    handleSessionExpired,
    persist,
    syncFromStorage,
  };
});
