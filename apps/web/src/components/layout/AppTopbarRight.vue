<script setup lang="ts">
import { computed } from "vue";
import { useRouter } from "vue-router";
import { SettingOutlined } from "@ant-design/icons-vue";
import { useSessionStore } from "@/stores/session";
import { useThemeStore } from "@/stores/theme";

const props = defineProps<{
  settingsTo: string;
}>();

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
    <slot name="status" />
    <slot name="extra" />
    <div class="faw-user-chip">
      <span class="faw-avatar" />
      @{{ username }}
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
      type="button"
      class="faw-icon-btn"
      title="Settings"
      @click="router.push(settingsTo)"
    >
      <SettingOutlined />
    </button>
  </div>
</template>
