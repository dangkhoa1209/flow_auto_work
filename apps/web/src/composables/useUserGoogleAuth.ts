import { onMounted, onUnmounted, ref } from "vue";
import { message } from "ant-design-vue";
import { api } from "@/api/client";
import { API } from "@/api/endpoints";
import { useSessionStore } from "@/stores/session";

export function useUserGoogleAuth() {
  const session = useSessionStore();
  const googleBusy = ref(false);
  const googleConfigured = ref(false);
  const googleAuthorized = ref(false);
  const googleEmail = ref<string | undefined>();
  const googleScopes = ref<string[]>([]);

  async function loadGoogleStatus() {
    try {
      const data = await api<{
        configured: boolean;
        authorized: boolean;
        email?: string;
        scopes?: string[];
      }>(API.me.googleStatus);
      googleConfigured.value = Boolean(data.configured);
      googleAuthorized.value = Boolean(data.authorized);
      googleEmail.value = data.email;
      googleScopes.value = data.scopes ?? [];
    } catch {
      googleConfigured.value = false;
      googleAuthorized.value = false;
      googleEmail.value = undefined;
      googleScopes.value = [];
    }
  }

  async function authorizeGoogle() {
    googleBusy.value = true;
    try {
      const data = await api<{ authUrl: string }>(API.me.googleAuthUrl);
      if (!data.authUrl) throw new Error("Không lấy được URL Google");
      const w = window.open(
        data.authUrl,
        "flow-google-oauth",
        "width=520,height=720",
      );
      if (!w) message.warning("Cho phép popup để Authorize Google");
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e));
    } finally {
      googleBusy.value = false;
    }
  }

  async function revokeGoogle() {
    googleBusy.value = true;
    try {
      await api(API.me.googleRevoke, { method: "POST" });
      message.success("Đã thu hồi Google");
      await loadGoogleStatus();
      await session.refreshMe();
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e));
    } finally {
      googleBusy.value = false;
    }
  }

  function onGoogleMessage(ev: MessageEvent) {
    const data = ev.data as { type?: string; ok?: boolean; jobId?: string | null } | null;
    if (!data || data.type !== "flow-google-oauth") return;
    if (data.jobId) return;
    void (async () => {
      await loadGoogleStatus();
      await session.refreshMe();
      if (data.ok) {
        message.success("Đã ủy quyền Google — dùng chung cho mọi task");
      } else {
        message.error("Ủy quyền Google thất bại");
      }
    })();
  }

  onMounted(() => {
    void loadGoogleStatus();
    window.addEventListener("message", onGoogleMessage);
  });

  onUnmounted(() => {
    window.removeEventListener("message", onGoogleMessage);
  });

  const hasDriveScope = () =>
    googleScopes.value.some(
      (s) => s.includes("auth/drive.readonly") || s.includes("auth/drive"),
    );

  return {
    googleBusy,
    googleConfigured,
    googleAuthorized,
    googleEmail,
    googleScopes,
    hasDriveScope,
    loadGoogleStatus,
    authorizeGoogle,
    revokeGoogle,
  };
}
