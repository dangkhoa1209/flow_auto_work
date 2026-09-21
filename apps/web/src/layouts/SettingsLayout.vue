<script setup lang="ts">
import { computed } from "vue";
import { useRoute } from "vue-router";
import SettingsShell from "@/components/layout/SettingsShell.vue";
import { resolveSettingsTabs } from "@/config/settingsNav";

const route = useRoute();

const nav = computed(() => resolveSettingsTabs(route.path));
</script>

<template>
  <SettingsShell
    title="Settings"
    :subtitle="nav.subtitle"
    :tabs="nav.tabs"
    :prefix-match="nav.prefixMatch"
  />
</template>
