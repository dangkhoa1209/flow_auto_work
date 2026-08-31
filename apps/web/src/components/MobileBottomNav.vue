<script setup lang="ts">
import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import {
  ThunderboltOutlined,
  MessageOutlined,
  BuildOutlined,
  SettingOutlined,
} from "@ant-design/icons-vue";
import { useSessionStore } from "@/stores/session";

const route = useRoute();
const router = useRouter();
const session = useSessionStore();

function settingsTarget(): { to: string; match: (path: string) => boolean } {
  if (route.path.startsWith("/ba")) {
    return {
      to: "/ba/settings/gitlab",
      match: (p) => p.startsWith("/ba/settings"),
    };
  }
  if (route.path.startsWith("/devops")) {
    return {
      to: "/devops/settings/account",
      match: (p) => p.startsWith("/devops/settings"),
    };
  }
  if (session.canAccessWork) {
    return {
      to: "/settings/project",
      match: (p) => p.startsWith("/settings"),
    };
  }
  if (session.canAccessBa) {
    return {
      to: "/ba/settings/gitlab",
      match: (p) => p.startsWith("/ba/settings"),
    };
  }
  return {
    to: "/devops/settings/account",
    match: (p) => p.startsWith("/devops/settings"),
  };
}

/** Mobile: app-level tabs when user has multiple surfaces. */
const tabs = computed(() => {
  const items: Array<{
    to: string;
    label: string;
    icon: typeof ThunderboltOutlined;
    match: (path: string) => boolean;
  }> = [];

  if (session.canAccessWork) {
    items.push({
      to: "/work",
      label: "Work",
      icon: ThunderboltOutlined,
      match: (p) =>
        p.startsWith("/work") ||
        p.startsWith("/handoff") ||
        p.startsWith("/stats"),
    });
  }
  if (session.canAccessBa) {
    items.push({
      to: "/ba",
      label: "Chat",
      icon: MessageOutlined,
      match: (p) => p.startsWith("/ba") && !p.startsWith("/ba/settings"),
    });
  }
  if (session.canAccessDevops) {
    items.push({
      to: "/devops",
      label: "Build",
      icon: BuildOutlined,
      match: (p) =>
        p.startsWith("/devops") && !p.startsWith("/devops/settings"),
    });
  }

  const settings = settingsTarget();
  items.push({
    to: settings.to,
    label: "Settings",
    icon: SettingOutlined,
    match: settings.match,
  });
  return items;
});

function isActive(tab: (typeof tabs.value)[0]) {
  return tab.match(route.path);
}

function go(tab: (typeof tabs.value)[0]) {
  void router.push(tab.to);
}
</script>

<template>
  <nav class="faw-mnav lg:hidden" aria-label="Bottom navigation">
    <div
      class="faw-mnav__grid"
      :style="{ gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))` }"
    >
      <button
        v-for="t in tabs"
        :key="t.to + t.label"
        type="button"
        class="faw-mnav__tab touch-manipulation fx-colors"
        :class="{ 'is-active': isActive(t) }"
        @click="go(t)"
      >
        <component :is="t.icon" class="faw-mnav__icon" />
        <span class="faw-mnav__label">{{ t.label }}</span>
      </button>
    </div>
  </nav>
</template>
