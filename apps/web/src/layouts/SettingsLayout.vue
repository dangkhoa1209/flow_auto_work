<script setup lang="ts">
import { useRoute, RouterLink, RouterView } from "vue-router";

const route = useRoute();

const tabs = [
  { to: "/settings/project", label: "Project" },
  { to: "/settings/integrations", label: "Integrations" },
  { to: "/settings/ai-engine", label: "AI Engine" },
  { to: "/settings/labels", label: "Labels" },
  { to: "/settings/account", label: "Account" },
];
</script>

<template>
  <div class="faw-settings h-full max-h-full min-h-0 overflow-hidden">
    <div class="faw-settings__shell">
      <aside class="faw-settings__nav" aria-label="Settings sections">
        <header class="faw-settings__head">
          <h1 class="faw-settings__title">Settings</h1>
        </header>
        <nav class="faw-settings__nav-list">
          <RouterLink
            v-for="t in tabs"
            :key="t.to"
            :to="t.to"
            class="faw-settings__nav-item"
            :class="{ 'is-active': route.path === t.to }"
          >
            {{ t.label }}
          </RouterLink>
        </nav>
      </aside>

      <div class="faw-settings__detail">
        <div class="faw-settings__panel">
          <RouterView />
        </div>
      </div>
    </div>
  </div>
</template>
