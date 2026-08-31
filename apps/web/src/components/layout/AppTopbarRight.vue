<script setup lang="ts">
import { computed } from "vue";
import { useRouter } from "vue-router";
import { SettingOutlined } from "@ant-design/icons-vue";
import { useSessionStore } from "@/stores/session";
import { useThemeStore } from "@/stores/theme";

withDefaults(
  defineProps<{
    settingsTo: string;
    /** When false, hide the settings icon entirely. */
    showSettings?: boolean;
  }>(),
  { showSettings: true },
);

const session = useSessionStore();
const themeStore = useThemeStore();
const router = useRouter();

const username = computed(
  () =>
    session.me?.gitlabUsername ||
    session.session.username ||
    "—",
);
</script>

<template>
  <div class="faw-topbar__right">
    <!-- Desktop-only chrome (mobile uses bottom nav for Settings) -->
    <div class="faw-topbar__right-desktop">
      <slot name="status" />
      <slot name="extra" />
      <div class="faw-user-chip">
        <span class="faw-avatar" />
        @{{ username }}
      </div>
    </div>
    <button
      type="button"
      class="faw-icon-btn"
      :title="
        themeStore.mode === 'dark'
          ? 'Switch to light mode'
          : 'Switch to dark mode'
      "
      @click="themeStore.toggle()"
    >
      {{ themeStore.mode === "dark" ? "☀" : "☾" }}
    </button>
    <button
      v-if="showSettings"
      type="button"
      class="faw-icon-btn faw-topbar__settings-btn"
      title="Settings"
      @click="router.push(settingsTo)"
    >
      <SettingOutlined />
    </button>
  </div>
</template>
