<script setup lang="ts">
import { computed } from "vue";
import { useRoute, RouterLink, RouterView } from "vue-router";

export type SettingsTab = {
  to: string;
  label: string;
};

const props = withDefaults(
  defineProps<{
    title?: string;
    tabs: SettingsTab[];
    /** Match route.path.startsWith when tab.to is a prefix (optional). */
    prefixMatch?: boolean;
  }>(),
  {
    title: "Settings",
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

const activePath = computed(() => route.path);
</script>

<template>
  <div class="faw-settings h-full max-h-full min-h-0 overflow-hidden">
    <div class="faw-settings__shell">
      <aside class="faw-settings__nav" aria-label="Settings sections">
        <header class="faw-settings__head">
          <h1 class="faw-settings__title">{{ title }}</h1>
        </header>
        <!-- Desktop: vertical list -->
        <nav class="faw-settings__nav-list hidden lg:flex">
          <RouterLink
            v-for="t in tabs"
            :key="t.to"
            :to="t.to"
            class="faw-settings__nav-item"
            :class="{ 'is-active': isActive(t) }"
          >
            {{ t.label }}
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
            {{ t.label }}
          </RouterLink>
        </nav>
      </aside>

      <div class="faw-settings__detail">
        <div class="faw-settings__panel">
          <RouterView :key="activePath" />
        </div>
      </div>
    </div>
  </div>
</template>
