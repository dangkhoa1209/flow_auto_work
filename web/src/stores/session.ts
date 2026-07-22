import { defineStore } from "pinia";
import { computed, ref } from "vue";
import {
  api,
  clearSession,
  loadSession,
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
    gitlabPath: string;
    repoPath?: string;
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

  const isLoggedIn = computed(
    () => Boolean(session.value.username && session.value.projectId),
  );

  const currentMembership = computed(() =>
    memberships.value.find((m) => m.projectId === session.value.projectId),
  );

  function persist() {
    saveSession(session.value);
  }

  async function refreshMe() {
    if (!session.value.username) {
      me.value = null;
      memberships.value = [];
      return;
    }
    const data = await api<{
      user?: UserPublic;
      memberships?: Membership[];
    }>("/api/me", { session: session.value });
    me.value = data.user ?? null;
    memberships.value = data.memberships ?? [];
    if (
      session.value.projectId &&
      !memberships.value.some((m) => m.projectId === session.value.projectId)
    ) {
      session.value.projectId = memberships.value[0]?.projectId ?? null;
      persist();
    }
  }

  async function bootstrap() {
    loading.value = true;
    try {
      if (session.value.username) {
        await refreshMe();
      }
    } catch {
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

  function logout() {
    clearSession();
    session.value = { username: null, projectId: null };
    me.value = null;
    memberships.value = [];
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
    logout,
    persist,
  };
});
