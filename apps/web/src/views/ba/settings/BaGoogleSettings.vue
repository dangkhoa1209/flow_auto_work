<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import { message } from "ant-design-vue";
import { api } from "@/api/client";
import { API } from "@/api/endpoints";
import { useSessionStore } from "@/stores/session";

const session = useSessionStore();
const googleBusy = ref(false);
const googleConfigured = ref(false);
const googleAuthorized = ref(false);
const googleEmail = ref<string | undefined>();

async function loadGoogleStatus() {
  try {
    const data = await api<{
      configured: boolean;
      authorized: boolean;
      email?: string;
    }>(API.ba.googleStatus);
    googleConfigured.value = Boolean(data.configured);
    googleAuthorized.value = Boolean(data.authorized);
    googleEmail.value = data.email;
  } catch {
    googleConfigured.value = false;
    googleAuthorized.value = false;
  }
}

async function authorizeGoogle() {
  googleBusy.value = true;
  try {
    const data = await api<{ authUrl: string }>(API.ba.googleAuthUrl);
    if (!data.authUrl) throw new Error("Không lấy được URL Google");
    const w = window.open(
      data.authUrl,
      "ba-google-oauth",
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
    await api(API.ba.googleRevoke, { method: "POST" });
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
  const data = ev.data as { type?: string; ok?: boolean } | null;
  if (!data || data.type !== "flow-google-oauth") return;
  void (async () => {
    await loadGoogleStatus();
    await session.refreshMe();
    if (data.ok) {
      message.success(
        "Đã ủy quyền Google — có thể đọc Docs/Sheets từ YC & chat",
      );
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
</script>

<template>
  <div class="faw-settings-detail">
    <h2>Google</h2>
    <p class="faw-settings-detail__lead">
      Đọc link Google Docs, Sheets, Excel trên Drive khi dán vào YC hoặc chat.
    </p>

    <a-alert
      v-if="!googleConfigured"
      type="warning"
      show-icon
      class="mb-4"
      message="Server chưa cấu hình Google OAuth"
    />
    <a-alert
      v-else-if="googleAuthorized"
      type="success"
      show-icon
      class="mb-4"
      :message="googleEmail ? `Đã ủy quyền · ${googleEmail}` : 'Đã ủy quyền'"
    />
    <a-alert
      v-else
      type="info"
      show-icon
      class="mb-4"
      message="Chưa ủy quyền Google"
    />

    <div class="flex flex-wrap gap-2">
      <a-button
        type="primary"
        :disabled="!googleConfigured || googleBusy"
        :loading="googleBusy"
        @click="authorizeGoogle"
      >
        {{ googleAuthorized ? "Ủy quyền lại" : "Authorize Google" }}
      </a-button>
      <a-button
        v-if="googleAuthorized"
        :disabled="googleBusy"
        @click="revokeGoogle"
      >
        Thu hồi
      </a-button>
    </div>
  </div>
</template>
