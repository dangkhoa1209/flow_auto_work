<script setup lang="ts">
import { computed } from "vue";
import { useUserGoogleAuth } from "@/composables/useUserGoogleAuth";

const {
  googleBusy,
  googleConfigured,
  googleAuthorized,
  googleEmail,
  hasDriveScope,
  authorizeGoogle,
  revokeGoogle,
} = useUserGoogleAuth();

const googleAlert = computed(() => {
  if (!googleConfigured.value) {
    return {
      type: "warning" as const,
      message: "Google OAuth is not configured on the server",
    };
  }
  if (googleAuthorized.value && hasDriveScope()) {
    return {
      type: "success" as const,
      message: googleEmail.value
        ? `Authorized · ${googleEmail.value}`
        : "Google authorized",
      description:
        "Applies to every job — tasks with Google Sheets/Excel links use this token; no per-task authorize needed.",
    };
  }
  if (googleAuthorized.value && !hasDriveScope()) {
    return {
      type: "warning" as const,
      message: googleEmail.value
        ? `Authorized · ${googleEmail.value}`
        : "Google authorized",
      description:
        "Missing Drive readonly scope — re-authorize to read Excel files on Drive.",
    };
  }
  return {
    type: "info" as const,
    message: "Google not authorized",
    description:
      "Click Authorize Google — a popup will request Sheets + Drive (readonly) access.",
  };
});
</script>

<template>
  <div class="faw-settings-detail">
    <h2>Google Auth</h2>
    <a-alert
      :type="googleAlert.type"
      show-icon
      :message="googleAlert.message"
      :description="googleAlert.description"
    />
    <div class="flex flex-wrap gap-2">
      <a-button
        type="primary"
        :loading="googleBusy"
        :disabled="!googleConfigured"
        @click="authorizeGoogle"
      >
        {{ googleAuthorized ? "Re-authorize" : "Authorize Google" }}
      </a-button>
      <a-button
        v-if="googleAuthorized"
        :loading="googleBusy"
        @click="revokeGoogle"
      >
        Revoke
      </a-button>
    </div>
  </div>
</template>
