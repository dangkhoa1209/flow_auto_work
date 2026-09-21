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
    if (!data.authUrl) throw new Error("Could not get Google auth URL");
    const w = window.open(
      data.authUrl,
      "ba-google-oauth",
      "width=520,height=720",
    );
    if (!w) message.warning("Allow popups to authorize Google");
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
    message.success("Google access revoked");
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
        "Google authorized — Docs/Sheets links work in requirements and chat",
      );
    } else {
      message.error("Google authorization failed");
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
      Read Google Docs, Sheets, and Drive Excel links pasted into requirements or
      chat.
    </p>

    <a-alert
      v-if="!googleConfigured"
      type="warning"
      show-icon
      class="mb-4"
      message="Google OAuth is not configured on the server"
    />
    <a-alert
      v-else-if="googleAuthorized"
      type="success"
      show-icon
      class="mb-4"
      :message="
        googleEmail ? `Authorized · ${googleEmail}` : 'Google authorized'
      "
    />
    <a-alert
      v-else
      type="info"
      show-icon
      class="mb-4"
      message="Google not authorized"
    />

    <div class="flex flex-wrap gap-2">
      <a-button
        type="primary"
        :disabled="!googleConfigured || googleBusy"
        :loading="googleBusy"
        @click="authorizeGoogle"
      >
        {{ googleAuthorized ? "Re-authorize" : "Authorize Google" }}
      </a-button>
      <a-button
        v-if="googleAuthorized"
        :disabled="googleBusy"
        @click="revokeGoogle"
      >
        Revoke
      </a-button>
    </div>
  </div>
</template>
