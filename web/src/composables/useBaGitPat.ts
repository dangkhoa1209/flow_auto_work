import { computed, ref } from "vue";
import { message } from "ant-design-vue";
import { api, ApiError } from "@/api/client";
import { API } from "@/api/endpoints";
import { useSessionStore } from "@/stores/session";

const modalOpen = ref(false);
const gitlabBaseUrl = ref("https://gitlab.com");
const gitlabPatUrl = ref(
  "https://gitlab.com/-/user_settings/personal_access_tokens",
);
const bootstrapLoaded = ref(false);
let pendingAction: (() => void) | null = null;

async function loadBootstrap() {
  if (bootstrapLoaded.value) return;
  try {
    const res = await api<{ gitlabBaseUrl?: string; gitlabPatUrl?: string }>(
      API.auth.bootstrap,
      { skipAuth: true },
    );
    if (res.gitlabBaseUrl) gitlabBaseUrl.value = res.gitlabBaseUrl;
    if (res.gitlabPatUrl) gitlabPatUrl.value = res.gitlabPatUrl;
  } catch {
    /* keep defaults */
  }
  bootstrapLoaded.value = true;
}

export async function ensureGitPatBootstrap() {
  await loadBootstrap();
}

export function isBaGitPatMissingError(err: unknown): boolean {
  return err instanceof ApiError && err.code === "ba_user_gitlab_pat_missing";
}

export function useBaGitPat() {
  const session = useSessionStore();

  const hasGitPat = computed(() => Boolean(session.me?.hasGitlabToken));

  async function openPatModal(onSaved?: () => void) {
    await loadBootstrap();
    pendingAction = onSaved ?? null;
    modalOpen.value = true;
  }

  /** Returns true when PAT exists; otherwise opens modal and returns false. */
  function requireGitPat(onSaved?: () => void): boolean {
    if (hasGitPat.value) return true;
    void openPatModal(onSaved);
    return false;
  }

  async function saveGitPat(token: string) {
    const trimmed = token.trim();
    if (!trimmed) {
      message.warning("Dán GitLab PAT trước khi lưu");
      return false;
    }
    await api(API.me.secrets, {
      method: "PUT",
      body: JSON.stringify({ gitlabToken: trimmed }),
    });
    await session.refreshMe();
    message.success("Đã lưu GitLab PAT — có thể lên task GitLab");
    modalOpen.value = false;
    const resume = pendingAction;
    pendingAction = null;
    resume?.();
    return true;
  }

  function closePatModal() {
    modalOpen.value = false;
    pendingAction = null;
  }

  function handleBaPatApiError(err: unknown, retry?: () => void): boolean {
    if (isBaGitPatMissingError(err)) {
      void openPatModal(retry);
      return true;
    }
    return false;
  }

  return {
    modalOpen,
    gitlabBaseUrl,
    gitlabPatUrl,
    hasGitPat,
    requireGitPat,
    openPatModal,
    saveGitPat,
    closePatModal,
    handleBaPatApiError,
    ensureGitPatBootstrap,
  };
}
