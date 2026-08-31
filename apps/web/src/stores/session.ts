import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { API } from "@/api/endpoints";
import { api } from "@/api/client";
import { useAuthStore } from "@/stores/auth";
import { resolveHomeRoute } from "@/utils/routeAccess";
import { effectiveRoles, hasAnyRole } from "@/utils/userRoles";
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
    gitProvider?: "gitlab" | "github";
    gitlabPath: string;
    gitlabHost?: string;
    repoPath?: string;
    localPath?: string;
    isActive?: boolean;
    cloneStatus?: string;
    cloneError?: string | null;
    hasGitlabToken?: boolean;
    hasFigmaToken?: boolean;
    mainBranch?: string | null;
    workingBranch?: string | null;
    defaultCommitMode?: "manual" | "auto" | null;
    /** When non-empty, Open tasks limited to these milestone titles */
    allowedMilestones?: string[];
  };
};

export type CursorPatPublic = {
  id: string;
  label: string;
  createdAt: string;
  updatedAt: string;
  isActive: boolean;
};

export type UserPublic = {
  id?: string;
  gitlabUsername?: string;
  username?: string;
  displayName?: string;
  hasPassword?: boolean;
  hasCursorApiKey?: boolean;
  cursorPats?: CursorPatPublic[];
  activeCursorPatId?: string | null;
  hasGitlabToken?: boolean;
  hasGoogleAuth?: boolean;
  googleEmail?: string;
  hasFigmaToken?: boolean;
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

  const roles = computed(() => effectiveRoles(me.value?.roles));

  const isAdmin = computed(() => roles.value.includes("admin"));

/** pd / ba / qc only — primary home is Project chat. */
  const isBaAudience = computed(() => {
    const r = roles.value;
    if (r.includes("admin")) return false;
    if (r.includes("dev")) return false;
    if (r.includes("devops")) return false;
    return r.includes("ba") || r.includes("pd") || r.includes("qc");
  });

  const canAccessWork = computed(() =>
    hasAnyRole(roles.value, "admin", "dev"),
  );

  const canAccessBa = computed(
    () =>
      isBaAudience.value ||
      hasAnyRole(roles.value, "admin", "dev", "devops"),
  );

  const canAccessDevops = computed(() =>
    hasAnyRole(roles.value, "admin", "devops", "dev"),
  );

  /** Edit build scripts — devops or admin (not plain dev). */
  const canConfigureDevopsScripts = computed(() =>
    hasAnyRole(roles.value, "admin", "devops"),
  );

  /** devops role, not dev (dev → /work). */
  const isDevopsAudience = computed(() => {
    const r = roles.value;
    if (r.includes("admin")) return false;
    if (r.includes("dev")) return false;
    return r.includes("devops");
  });

  const homeRoute = computed(() =>
    resolveHomeRoute({
      isAdmin: isAdmin.value,
      isDevopsAudience: isDevopsAudience.value,
      canAccessWork: canAccessWork.value,
      canAccessBa: canAccessBa.value,
      canAccessDevops: canAccessDevops.value,
    }),
  );

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

  function setMe(user: UserPublic | null) {
    me.value = user;
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

  function clearBaChatState() {
    void import("@/stores/baChat")
      .then((m) => m.useBaChatStore().reset())
      .catch(() => undefined);
  }

  async function logout() {
    clearBaChatState();
    await auth.logout();
    projectId.value = null;
    me.value = null;
    memberships.value = [];
  }

  function handleSessionExpired() {
    clearBaChatState();
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
    isAdmin,
    isBaAudience,
    canAccessWork,
    canAccessBa,
    canAccessDevops,
    canConfigureDevopsScripts,
    isDevopsAudience,
    homeRoute,
    currentMembership,
    bootstrap,
    refreshMe,
    setMe,
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
