<script setup lang="ts">
import { computed, ref } from "vue";
import { message } from "ant-design-vue";
import { api } from "@/api/client";
import { API } from "@/api/endpoints";
import { useSessionStore } from "@/stores/session";
import { useUserGoogleAuth } from "@/composables/useUserGoogleAuth";
import SettingsGoogleAuthPanel from "@/components/settings/SettingsGoogleAuthPanel.vue";

type IntegrationId = "google" | "figma";

const session = useSessionStore();
const {
  googleConfigured,
  googleAuthorized,
  hasDriveScope,
} = useUserGoogleAuth();

const activeId = ref<IntegrationId>("google");
const loading = ref(false);
const figmaToken = ref("");
const clearFigma = ref(false);

const hasFigmaToken = computed(
  () => Boolean(session.me?.hasFigmaToken),
);

const googleStatusLabel = computed(() => {
  if (!googleConfigured.value) return "Chưa cấu hình server";
  if (googleAuthorized.value) {
    if (!hasDriveScope()) return "Thiếu scope Drive";
    return "Đã ủy quyền";
  }
  return "Chưa ủy quyền";
});

const googleStatusOk = computed(
  () =>
    googleConfigured.value &&
    googleAuthorized.value &&
    hasDriveScope(),
);

const figmaStatusLabel = computed(() =>
  hasFigmaToken.value ? "PAT đã lưu" : "Chưa có PAT",
);

const integrations = computed(() => [
  {
    id: "google" as const,
    label: "Google Auth",
    hint: "Tài khoản · mọi project",
    status: googleStatusLabel.value,
    ok: googleStatusOk.value,
  },
  {
    id: "figma" as const,
    label: "Figma",
    hint: "Tài khoản · mọi project",
    status: figmaStatusLabel.value,
    ok: hasFigmaToken.value,
  },
]);

const figmaAlert = computed(() =>
  hasFigmaToken.value
    ? {
        type: "success" as const,
        message: "PAT đã lưu",
        description:
          "Dùng chung mọi project — task tick link Figma sẽ dùng PAT này.",
      }
    : {
        type: "warning" as const,
        message: "Chưa có Figma PAT",
        description: "Dán Personal access token bên dưới (một lần cho mọi project).",
      },
);

function selectIntegration(id: IntegrationId) {
  activeId.value = id;
}

async function saveFigma() {
  const clearing = clearFigma.value;
  if (!clearing && !figmaToken.value.trim()) {
    message.warning("Dán Figma PAT hoặc tick Xóa token");
    return;
  }
  loading.value = true;
  try {
    const res = await api<{ user?: { hasFigmaToken?: boolean }; ok?: boolean }>(
      API.me.integrations,
      {
        method: "PUT",
        body: JSON.stringify({
          figmaToken: clearing ? "" : figmaToken.value.trim(),
        }),
      },
    );
    if (res.user) {
      session.me = { ...session.me, ...res.user };
    } else {
      await session.refreshMe();
    }
    figmaToken.value = "";
    clearFigma.value = false;
    message.success(
      clearing || res.user?.hasFigmaToken === false
        ? "Đã xóa Figma PAT"
        : "Đã lưu Figma PAT",
    );
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="faw-integrations">
    <header class="faw-settings-detail faw-integrations__head">
      <h2>Integrations</h2>
    </header>

    <div class="faw-integrations__shell">
      <aside class="faw-integrations__list" aria-label="Danh sách integrations">
        <button
          v-for="item in integrations"
          :key="item.id"
          type="button"
          class="faw-integrations__item"
          :class="{ 'is-active': activeId === item.id }"
          @click="selectIntegration(item.id)"
        >
          <span class="faw-integrations__item-top">
            <span class="faw-integrations__item-label">{{ item.label }}</span>
            <span
              class="faw-integrations__item-badge"
              :class="item.ok ? 'is-ok' : ''"
            >
              {{ item.status }}
            </span>
          </span>
          <span class="faw-integrations__item-hint">{{ item.hint }}</span>
        </button>
      </aside>

      <div class="faw-integrations__detail">
        <SettingsGoogleAuthPanel v-if="activeId === 'google'" />

        <div v-else class="faw-settings-detail">
          <h2>Figma</h2>
          <a-alert
            :type="figmaAlert.type"
            show-icon
            :message="figmaAlert.message"
            :description="figmaAlert.description"
          />
          <a-form layout="vertical">
            <a-form-item label="Personal access token">
              <a-input-password
                v-model:value="figmaToken"
                placeholder="figu_… (để trống nếu chỉ xóa)"
                autocomplete="new-password"
                :disabled="clearFigma"
              />
              <p class="text-xs text-ink-faint m-0 mt-1">
                Figma → Settings → Security → Personal access tokens, scope
                <code>file_content:read</code>.
              </p>
            </a-form-item>
            <a-form-item>
              <a-checkbox
                v-model:checked="clearFigma"
                :disabled="!hasFigmaToken"
              >
                Xóa Figma PAT đã lưu
              </a-checkbox>
            </a-form-item>
            <a-button type="primary" :loading="loading" @click="saveFigma">
              Lưu Figma PAT
            </a-button>
          </a-form>
        </div>
      </div>
    </div>
  </div>
</template>
