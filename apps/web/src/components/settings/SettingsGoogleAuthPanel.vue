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
      message: "Server chưa cấu hình Google OAuth",
    };
  }
  if (googleAuthorized.value && hasDriveScope()) {
    return {
      type: "success" as const,
      message: googleEmail.value
        ? `Đã ủy quyền · ${googleEmail.value}`
        : "Đã ủy quyền Google",
      description:
        "Áp dụng cho mọi job — task có link Google Sheets/Excel dùng token này, không cần Authorize từng task.",
    };
  }
  if (googleAuthorized.value && !hasDriveScope()) {
    return {
      type: "warning" as const,
      message: googleEmail.value
        ? `Đã ủy quyền · ${googleEmail.value}`
        : "Đã ủy quyền Google",
      description:
        "Thiếu quyền Drive readonly — bấm Ủy quyền lại để đọc file Excel trên Drive.",
    };
  }
  return {
    type: "info" as const,
    message: "Chưa ủy quyền Google",
    description:
      "Bấm Authorize Google — popup sẽ mở để cấp quyền đọc Sheets + Drive (readonly).",
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
        {{ googleAuthorized ? "Ủy quyền lại" : "Authorize Google" }}
      </a-button>
      <a-button
        v-if="googleAuthorized"
        :loading="googleBusy"
        @click="revokeGoogle"
      >
        Thu hồi
      </a-button>
    </div>
  </div>
</template>
