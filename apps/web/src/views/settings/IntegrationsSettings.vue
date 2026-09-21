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
  if (!googleConfigured.value) return "Server not configured";
  if (googleAuthorized.value) {
    if (!hasDriveScope()) return "Missing Drive scope";
    return "Authorized";
  }
  return "Not authorized";
});

const googleStatusOk = computed(
  () =>
    googleConfigured.value &&
    googleAuthorized.value &&
    hasDriveScope(),
);

const figmaStatusLabel = computed(() =>
  hasFigmaToken.value ? "PAT saved" : "No PAT",
);

const integrations = computed(() => [
  {
    id: "google" as const,
    label: "Google Auth",
    hint: "Account · all projects",
    status: googleStatusLabel.value,
    ok: googleStatusOk.value,
  },
  {
    id: "figma" as const,
    label: "Figma",
    hint: "Account · all projects",
    status: figmaStatusLabel.value,
    ok: hasFigmaToken.value,
  },
]);

const figmaAlert = computed(() =>
  hasFigmaToken.value
    ? {
        type: "success" as const,
        message: "PAT saved",
        description:
          "Shared across projects — tasks with Figma links use this PAT.",
      }
    : {
        type: "warning" as const,
        message: "No Figma PAT",
        description:
          "Paste a personal access token below (once for all projects).",
      },
);

function selectIntegration(id: IntegrationId) {
  activeId.value = id;
}

async function saveFigma() {
  const clearing = clearFigma.value;
  if (!clearing && !figmaToken.value.trim()) {
    message.warning("Paste a Figma PAT or check Clear saved token");
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
        ? "Figma PAT removed"
        : "Figma PAT saved",
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
      <p class="faw-settings-detail__lead m-0 mt-1">
        Connect Google and Figma for this account across all projects.
      </p>
    </header>

    <div class="faw-integrations__shell">
      <aside class="faw-integrations__list" aria-label="Integrations list">
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
                placeholder="figu_… (leave blank to clear only)"
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
                Clear saved Figma PAT
              </a-checkbox>
            </a-form-item>
            <a-button type="primary" :loading="loading" @click="saveFigma">
              Save Figma PAT
            </a-button>
          </a-form>
        </div>
      </div>
    </div>
  </div>
</template>
