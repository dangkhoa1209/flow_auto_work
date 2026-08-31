<script setup lang="ts">
import SettingsShell from "@/components/layout/SettingsShell.vue";

const tabs = [
  { to: "/settings/project", label: "Project" },
  { to: "/settings/integrations", label: "Integrations" },
  { to: "/settings/ai-engine", label: "AI Engine" },
  { to: "/settings/labels", label: "Labels" },
  { to: "/settings/account", label: "Account" },
];
</script>

<template>
  <SettingsShell title="Settings" :tabs="tabs" />
</template>
