<script setup lang="ts">
import { computed } from "vue";
import SettingsShell from "@/components/layout/SettingsShell.vue";
import { useProjectChatBase } from "@/composables/useProjectChatBase";

const { basePath } = useProjectChatBase();

const tabs = computed(() => [
  { to: `${basePath.value}/settings/gitlab`, label: "GitLab PAT" },
  { to: `${basePath.value}/settings/google`, label: "Google" },
  { to: `${basePath.value}/settings/account`, label: "Account" },
]);
</script>

<template>
  <SettingsShell title="Settings" :tabs="tabs" prefix-match />
</template>
