<script setup lang="ts">
import { useRoute, RouterLink, RouterView } from "vue-router";
import { ArrowLeftOutlined } from "@ant-design/icons-vue";

const route = useRoute();

const tabs = [
  { to: "/settings/project", label: "Project" },
  { to: "/settings/cursor", label: "Cursor" },
  { to: "/settings/labels", label: "Labels" },
  { to: "/settings/account", label: "Account" },
];
</script>

<template>
  <div class="h-full max-h-full min-h-0 overflow-y-auto">
    <div class="max-w-3xl mx-auto px-4 py-6">
      <div class="flex items-center gap-3 mb-6">
        <RouterLink
          to="/work"
          class="inline-flex items-center gap-1 text-sm text-ink-muted hover:text-accent font-medium"
        >
          <ArrowLeftOutlined /> Work
        </RouterLink>
        <h1 class="text-xl font-semibold text-ink m-0">Settings</h1>
      </div>

      <div class="flex gap-2 mb-6 flex-wrap">
        <RouterLink
          v-for="t in tabs"
          :key="t.to"
          :to="t.to"
          class="px-3 py-1.5 rounded-full text-sm border border-line text-ink-muted hover:text-ink hover:border-accent/40 bg-surface-raised/70 transition"
          :class="
            route.path === t.to
              ? '!border-accent !text-accent !bg-accent-soft font-semibold'
              : ''
          "
        >
          {{ t.label }}
        </RouterLink>
      </div>

      <div class="rounded-2xl border border-line bg-surface-raised/90 shadow-panel p-5">
        <RouterView />
      </div>
    </div>
  </div>
</template>
