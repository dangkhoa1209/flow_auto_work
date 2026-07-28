import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { authApi, type AuthTokensResponse } from "@/api/authApi";
import { refreshAccessTokenRaw } from "@/api/http";
import {
  applyTokenPair,
  clearPersistedAuth,
  getAccessExpiresAt,
  getAccessToken,
  getRefreshToken,
  loadPersistedAuth,
  savePersistedAuth,
  setAccessToken,
} from "@/api/tokenStorage";

export type AuthUser = {
  gitlabUsername?: string;
  username?: string;
};

/** Mirrors `web/src/stores/auth.ts` — same Flow account surface. */
export const useAuthStore = defineStore("auth", () => {
  const accessToken = ref<string | null>(getAccessToken());
  const refreshToken = ref<string | null>(getRefreshToken());
  const accessExpiresAt = ref<number | null>(getAccessExpiresAt());
  const username = ref<string | null>(loadPersistedAuth().username);
  const user = ref<AuthUser | null>(
    username.value ? { gitlabUsername: username.value } : null,
  );

  const isAuthenticated = computed(
    () => Boolean((accessToken.value || refreshToken.value) && username.value),
  );

  function syncFromBridge() {
    accessToken.value = getAccessToken();
    refreshToken.value = getRefreshToken();
    accessExpiresAt.value = getAccessExpiresAt();
    const p = loadPersistedAuth();
    username.value = p.username;
    if (p.username) {
      user.value = { gitlabUsername: p.username, ...(user.value || {}) };
    }
  }

  function setTokens(opts: {
    accessToken: string;
    refreshToken: string;
    expiresIn?: number;
    accessExpiresAt?: number;
    username?: string | null;
    projectId?: string | null;
    user?: AuthUser | null;
  }) {
    applyTokenPair({
      accessToken: opts.accessToken,
      refreshToken: opts.refreshToken,
      expiresIn: opts.expiresIn,
      accessExpiresAt: opts.accessExpiresAt,
      username: opts.username,
      projectId: opts.projectId,
    });
    if (opts.user) user.value = opts.user;
    syncFromBridge();
  }

  function setUsername(name: string | null) {
    username.value = name;
    savePersistedAuth({ username: name });
    if (name) {
      user.value = { gitlabUsername: name, ...(user.value || {}) };
    }
  }

  function setProjectId(projectId: string | null) {
    savePersistedAuth({ projectId });
  }

  async function login(uname: string, password: string) {
    const res = await authApi.login(uname, password);
    applyAuthResponse(res, uname);
    return res;
  }

  async function register(opts: {
    username: string;
    password: string;
    displayName?: string;
  }) {
    const res = await authApi.register(opts);
    applyAuthResponse(res, opts.username);
    return res;
  }

  function applyAuthResponse(res: AuthTokensResponse, fallbackUser: string) {
    const name = (
      res.user?.gitlabUsername ||
      res.user?.username ||
      fallbackUser
    ).replace(/^@/, "");
    setTokens({
      accessToken: res.accessToken,
      refreshToken: res.refreshToken,
      expiresIn: res.expiresIn,
      accessExpiresAt: res.accessExpiresAt,
      username: name,
      projectId: res.activeProjectId || res.memberships?.[0]?.projectId || null,
      user: res.user,
    });
  }

  async function refresh(): Promise<boolean> {
    try {
      if (!getRefreshToken()) return false;
      await refreshAccessTokenRaw();
      syncFromBridge();
      return true;
    } catch {
      clearLocal();
      return false;
    }
  }

  function clearLocal() {
    clearPersistedAuth();
    setAccessToken(null, null);
    accessToken.value = null;
    refreshToken.value = null;
    accessExpiresAt.value = null;
    username.value = null;
    user.value = null;
  }

  async function logout() {
    const rt = getRefreshToken();
    clearLocal();
    if (rt) {
      void authApi.logout(rt).catch(() => undefined);
    }
  }

  function hydrate() {
    const p = loadPersistedAuth();
    refreshToken.value = p.refreshToken;
    username.value = p.username;
    accessToken.value = getAccessToken();
    accessExpiresAt.value = getAccessExpiresAt();
    if (p.username) {
      user.value = { gitlabUsername: p.username };
    }
  }

  hydrate();

  return {
    accessToken,
    refreshToken,
    accessExpiresAt,
    username,
    user,
    isAuthenticated,
    syncFromBridge,
    setTokens,
    setUsername,
    setProjectId,
    login,
    register,
    refresh,
    logout,
    clearLocal,
    hydrate,
  };
});
