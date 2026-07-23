import { defineStore } from "pinia";
import { computed, ref } from "vue";
import {
  api,
  applyAuthTokens,
  clearSession,
  loadSession,
  refreshAccessToken,
  saveSession,
  type Session,
} from "@/api/client";

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
};

export const useSessionStore = defineStore("session", () => {
  const session = ref<Session>(loadSession());
  const me = ref<UserPublic | null>(null);
  const memberships = ref<Membership[]>([]);
  const loading = ref(false);
  const bootstrapped = ref(false);

  /** Có refresh token = còn phiên (project có thể chọn sau ở Settings). */
  const isLoggedIn = computed(
    () =>
      Boolean(
        (session.value.accessToken || session.value.refreshToken) &&
          session.value.username,
      ),
  );

  const currentMembership = computed(() =>
    memberships.value.find((m) => m.projectId === session.value.projectId),
  );

  function persist() {
    saveSession(session.value);
  }

  function syncFromStorage() {
    session.value = loadSession();
  }

  function normalizeMemberships(list: Membership[] | undefined | null): Membership[] {
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

  /** Không bao giờ xóa projectId đang chọn — chỉ đổi khi list có project khác. */
  function reconcileProjectId() {
    const pid = session.value.projectId;
    if (!pid) {
      const first = memberships.value[0]?.projectId;
      if (first) session.value.projectId = first;
      return;
    }
    if (memberships.value.length === 0) return;
    const ok = memberships.value.some(
      (m) => m.projectId === pid || m.project?.id === pid,
    );
    if (!ok) {
      session.value.projectId = memberships.value[0]?.projectId ?? pid;
    }
  }

  async function refreshMe() {
    // Giữ bản in-memory (vừa set sau login/join), chỉ backfill token từ storage
    const memory = { ...session.value };
    const stored = loadSession();
    session.value = {
      ...stored,
      ...memory,
      accessToken: memory.accessToken || stored.accessToken,
      refreshToken: memory.refreshToken || stored.refreshToken,
      accessExpiresAt: memory.accessExpiresAt || stored.accessExpiresAt,
      username: memory.username || stored.username,
      projectId: memory.projectId || stored.projectId,
    };
    persist();

    if (!session.value.username && !session.value.accessToken) {
      me.value = null;
      memberships.value = [];
      return;
    }
    const data = await api<{
      user?: UserPublic;
      memberships?: Membership[];
    }>("/api/me", { session: session.value });
    me.value = data.user ?? null;
    setMemberships(data.memberships);
    if (data.user?.gitlabUsername) {
      session.value.username = data.user.gitlabUsername;
    }
    reconcileProjectId();
    persist();
  }

  async function bootstrap() {
    loading.value = true;
    try {
      syncFromStorage();
      if (!session.value.refreshToken && !session.value.accessToken) {
        return;
      }
      // Access hết hạn → refresh trước
      if (
        session.value.refreshToken &&
        (!session.value.accessToken ||
          (session.value.accessExpiresAt &&
            session.value.accessExpiresAt < Date.now() + 5_000))
      ) {
        const ok = await refreshAccessToken();
        syncFromStorage();
        if (!ok) {
          logout();
          return;
        }
      }
      await refreshMe();
      syncFromStorage();
    } catch {
      // Thử refresh 1 lần rồi mới logout
      const ok = await refreshAccessToken();
      syncFromStorage();
      if (ok) {
        try {
          await refreshMe();
          return;
        } catch {
          /* fallthrough */
        }
      }
      logout();
    } finally {
      bootstrapped.value = true;
      loading.value = false;
    }
  }

  function setSession(next: Partial<Session>) {
    session.value = { ...session.value, ...next };
    persist();
  }

  function setAuthTokens(tokens: {
    accessToken: string;
    refreshToken: string;
    expiresIn?: number;
    accessExpiresAt?: number;
    username?: string;
  }) {
    applyAuthTokens(tokens);
    session.value = loadSession();
    if (tokens.username) {
      session.value.username = tokens.username;
      persist();
    }
  }

  async function logout() {
    const prev = loadSession();
    const refreshToken = prev.refreshToken;
    if (prev.username) {
      try {
        localStorage.setItem(
          "flow_auto_work_last_login",
          JSON.stringify({
            username: prev.username,
            projectId: prev.projectId,
          }),
        );
      } catch {
        /* ignore */
      }
    }
    clearSession();
    session.value = {
      username: null,
      projectId: null,
      accessToken: null,
      refreshToken: null,
      accessExpiresAt: null,
    };
    me.value = null;
    memberships.value = [];

    if (refreshToken) {
      void api("/api/auth/logout", {
        method: "POST",
        body: JSON.stringify({ refreshToken }),
        skipRefresh: true,
      }).catch(() => undefined);
    }
  }

  /** Sync Pinia after localStorage was cleared by api client */
  function handleSessionExpired() {
    session.value = {
      username: null,
      projectId: null,
      accessToken: null,
      refreshToken: null,
      accessExpiresAt: null,
    };
    me.value = null;
    memberships.value = [];
  }

  if (typeof window !== "undefined") {
    window.addEventListener("flow:session-expired", handleSessionExpired);
  }

  /** Activate project on server + update session.projectId */
  async function activateProject(projectId: string): Promise<void> {
    const id = projectId.trim();
    if (!id) throw new Error("projectId required");
    const res = await api<{ memberships?: Membership[] }>(
      `/api/projects/${encodeURIComponent(id)}/activate`,
      { method: "POST", body: "{}" },
    );
    if (res.memberships) setMemberships(res.memberships);
    setSession({ projectId: id });
    await refreshMe();
  }

  return {
    session,
    me,
    memberships,
    loading,
    bootstrapped,
    isLoggedIn,
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
