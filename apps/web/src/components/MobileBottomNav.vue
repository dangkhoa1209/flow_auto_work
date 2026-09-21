<script setup lang="ts">
import { computed, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import {
  ThunderboltOutlined,
  MessageOutlined,
  BuildOutlined,
  SettingOutlined,
  ControlOutlined,
} from "@ant-design/icons-vue";
import { useSessionStore } from "@/stores/session";
import {
  resolveSettingsShell,
  settingsDefaultPath,
} from "@/config/settingsNav";

const route = useRoute();
const router = useRouter();
const session = useSessionStore();
const navigating = ref(false);

function settingsTarget(): { to: string; match: (path: string) => boolean } {
  const path = route.path;
  if (
    path.startsWith("/admin") ||
    path.startsWith("/ba") ||
    path.startsWith("/qc") ||
    path.startsWith("/devops") ||
    path.startsWith("/settings") ||
    path.startsWith("/dev") ||
    path.startsWith("/handoff") ||
    path.startsWith("/stats")
  ) {
    const shell = resolveSettingsShell(path);
    const base = settingsDefaultPath(path);
    const matchPrefix =
      shell === "code"
        ? "/settings"
        : shell === "chatbox"
          ? path.startsWith("/qc")
            ? "/qc/settings"
            : "/ba/settings"
          : shell === "build"
            ? "/devops/settings"
            : "/admin/settings";
    return {
      to: base,
      match: (p) => p.startsWith(matchPrefix),
    };
  }
  if (session.canAccessWork) {
    return {
      to: settingsDefaultPath("code"),
      match: (p) => p.startsWith("/settings"),
    };
  }
  if (session.canAccessBa) {
    return {
      to: settingsDefaultPath("/ba"),
      match: (p) => p.startsWith("/ba/settings"),
    };
  }
  if (session.canAccessQc) {
    return {
      to: settingsDefaultPath("/qc"),
      match: (p) => p.startsWith("/qc/settings"),
    };
  }
  if (session.isAdmin) {
    return {
      to: settingsDefaultPath("admin"),
      match: (p) => p.startsWith("/admin/settings"),
    };
  }
  return {
    to: settingsDefaultPath("build"),
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

  if (session.isAdmin) {
    items.push({
      to: "/admin/users",
      label: "Admin",
      icon: ControlOutlined,
      match: (p) => p.startsWith("/admin") && !p.startsWith("/admin/settings"),
    });
  }
  if (session.canAccessWork) {
    items.push({
      to: "/dev",
      label: "Code",
      icon: ThunderboltOutlined,
      match: (p) =>
        p === "/dev" ||
        p.startsWith("/dev/") ||
        p.startsWith("/handoff") ||
        p.startsWith("/stats"),
    });
  }
  if (session.canAccessBa) {
    items.push({
      to: "/ba",
      label: "ChatBox",
      icon: MessageOutlined,
      match: (p) => p.startsWith("/ba") && !p.startsWith("/ba/settings"),
    });
  }
  if (session.canAccessQc) {
    items.push({
      to: "/qc",
      label: "QC",
      icon: MessageOutlined,
      match: (p) => p.startsWith("/qc") && !p.startsWith("/qc/settings"),
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

async function go(tab: (typeof tabs.value)[0]) {
  if (isActive(tab)) return;
  if (navigating.value) return;
  navigating.value = true;
  try {
    await router.push(tab.to);
  } finally {
    navigating.value = false;
  }
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
