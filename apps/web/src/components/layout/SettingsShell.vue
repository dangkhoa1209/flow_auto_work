<script setup lang="ts">
import { computed, type Component } from "vue";
import { useRoute, RouterLink, RouterView } from "vue-router";
import {
  ApiOutlined,
  FolderOutlined,
  GoogleOutlined,
  KeyOutlined,
  RobotOutlined,
  TagOutlined,
  UserOutlined,
} from "@ant-design/icons-vue";
import type { SettingsIconKey, SettingsTab } from "@/config/settingsNav";

export type { SettingsTab };

const ICON_MAP: Record<SettingsIconKey, Component> = {
  project: FolderOutlined,
  api: ApiOutlined,
  robot: RobotOutlined,
  tag: TagOutlined,
  user: UserOutlined,
  key: KeyOutlined,
  google: GoogleOutlined,
};

const props = withDefaults(
  defineProps<{
    title?: string;
    subtitle?: string;
    tabs: SettingsTab[];
    /** Match route.path.startsWith when tab.to is a prefix (optional). */
    prefixMatch?: boolean;
  }>(),
  {
    title: "Settings",
    subtitle: "",
    prefixMatch: false,
  },
);

const route = useRoute();

function isActive(tab: SettingsTab): boolean {
  if (props.prefixMatch) {
    return route.path === tab.to || route.path.startsWith(`${tab.to}/`);
  }
  return route.path === tab.to;
}

function iconFor(key: SettingsIconKey): Component {
  return ICON_MAP[key] ?? FolderOutlined;
}

const activePath = computed(() => route.path);

const activeTab = computed(
  () => props.tabs.find((t) => isActive(t)) ?? props.tabs[0] ?? null,
);
</script>

<template>
  <div class="faw-settings h-full max-h-full min-h-0 overflow-hidden">
    <div class="faw-settings__shell">
      <aside class="faw-settings__nav" aria-label="Settings sections">
        <header class="faw-settings__head">
          <h1 class="faw-settings__title">{{ title }}</h1>
          <p v-if="subtitle" class="faw-settings__subtitle">{{ subtitle }}</p>
        </header>

        <!-- Desktop: vertical list with icon + hint -->
        <nav class="faw-settings__nav-list hidden lg:flex">
          <RouterLink
            v-for="t in tabs"
            :key="t.to"
            :to="t.to"
            class="faw-settings__nav-item"
            :class="{ 'is-active': isActive(t) }"
          >
            <span class="faw-settings__nav-icon" aria-hidden="true">
              <component :is="iconFor(t.icon)" />
            </span>
            <span class="faw-settings__nav-text">
              <span class="faw-settings__nav-label">{{ t.label }}</span>
              <span class="faw-settings__nav-hint">{{ t.description }}</span>
            </span>
          </RouterLink>
        </nav>

        <!-- Mobile: horizontal chips -->
        <nav class="faw-settings__tabs lg:hidden" aria-label="Settings tabs">
          <RouterLink
            v-for="t in tabs"
            :key="`m-${t.to}`"
            :to="t.to"
            class="faw-settings__tab"
            :class="{ 'is-active': isActive(t) }"
          >
            <span class="faw-settings__tab-icon" aria-hidden="true">
              <component :is="iconFor(t.icon)" />
            </span>
            <span>{{ t.label }}</span>
          </RouterLink>
        </nav>
      </aside>

      <div class="faw-settings__detail">
        <div
          v-if="activeTab"
          class="faw-settings__panel-head lg:hidden"
          aria-hidden="true"
        >
          <span class="faw-settings__panel-head-label">{{
            activeTab.label
          }}</span>
          <span class="faw-settings__panel-head-hint">{{
            activeTab.description
          }}</span>
        </div>
        <div class="faw-settings__panel">
          <RouterView :key="activePath" />
        </div>
      </div>
    </div>
  </div>
</template>
