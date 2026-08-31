<script setup lang="ts">
import SettingsShell from "@/components/layout/SettingsShell.vue";

const tabs = [
  { to: "/ba/settings/gitlab", label: "GitLab PAT" },
  { to: "/ba/settings/google", label: "Google" },
  { to: "/ba/settings/account", label: "Account" },
];
</script>

<template>
  <SettingsShell title="Settings" :tabs="tabs" prefix-match />
</template>
