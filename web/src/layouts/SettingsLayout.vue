<script setup lang="ts">
import { useRoute, RouterLink, RouterView } from "vue-router";

const route = useRoute();

const tabs = [
  { to: "/settings/project", label: "Project" },
  { to: "/settings/cursor", label: "Cursor" },
  { to: "/settings/labels", label: "Labels" },
  { to: "/settings/account", label: "Account" },
];
</script>

<template>
  <div class="faw-settings h-full max-h-full min-h-0 overflow-y-auto overflow-x-hidden">
    <div class="faw-settings__inner">
      <header class="faw-settings__head">
        <h1 class="faw-settings__title">Settings</h1>
      </header>

      <nav class="faw-settings__tabs" aria-label="Settings sections">
        <RouterLink
          v-for="t in tabs"
          :key="t.to"
          :to="t.to"
          class="faw-settings__tab"
          :class="{ 'is-active': route.path === t.to }"
        >
          {{ t.label }}
        </RouterLink>
      </nav>

      <div class="faw-settings__panel">
        <RouterView />
      </div>
    </div>
  </div>
</template>
