<script setup lang="ts">
import { type Component } from "vue";
import { useRoute, RouterLink, RouterView } from "vue-router";
import {
  ApiOutlined,
  BarChartOutlined,
  CloudSyncOutlined,
  DashboardOutlined,
  MessageOutlined,
  RobotOutlined,
  TagOutlined,
  TeamOutlined,
} from "@ant-design/icons-vue";
import {
  ADMIN_TABS,
  isAdminTabActive,
  type AdminIconKey,
  type AdminTab,
} from "@/config/adminNav";

const ICON_MAP: Record<AdminIconKey, Component> = {
  dashboard: DashboardOutlined,
  users: TeamOutlined,
  usage: BarChartOutlined,
  chatbox: MessageOutlined,
  robot: RobotOutlined,
  tag: TagOutlined,
  features: ApiOutlined,
  sync: CloudSyncOutlined,
};

const route = useRoute();

const tabs = ADMIN_TABS;

function isActive(tab: AdminTab): boolean {
  return isAdminTabActive(tab, route.path);
}

function iconFor(key: AdminIconKey): Component {
  return ICON_MAP[key] ?? TeamOutlined;
}
</script>

<template>
  <div class="faw-admin h-full max-h-full min-h-0 overflow-hidden">
    <div class="faw-admin__shell">
      <aside class="faw-admin__nav">
        <header class="faw-admin__head">
          <h1 class="faw-admin__title">Admin</h1>
          <p class="faw-admin__subtitle">System console</p>
        </header>

        <nav class="faw-admin__nav-list" aria-label="Admin sections">
          <RouterLink
            v-for="t in tabs"
            :key="t.to"
            :to="t.to"
            class="faw-admin__nav-item"
            :class="{ 'is-active': isActive(t) }"
          >
            <span class="faw-admin__nav-icon" aria-hidden="true">
              <component :is="iconFor(t.icon)" />
            </span>
            <span class="faw-admin__nav-text">
              <span class="faw-admin__nav-label">{{ t.label }}</span>
              <span class="faw-admin__nav-hint">{{ t.description }}</span>
            </span>
          </RouterLink>
        </nav>

        <nav class="faw-admin__tabs" aria-label="Admin tabs">
          <RouterLink
            v-for="t in tabs"
            :key="`m-${t.to}`"
            :to="t.to"
            class="faw-admin__tab"
            :class="{ 'is-active': isActive(t) }"
          >
            <span class="faw-admin__tab-icon" aria-hidden="true">
              <component :is="iconFor(t.icon)" />
            </span>
            <span>{{ t.short }}</span>
          </RouterLink>
        </nav>
      </aside>

      <div class="faw-admin__detail">
        <div class="faw-admin__panel">
          <RouterView :key="route.path" />
        </div>
      </div>
    </div>
  </div>
</template>
