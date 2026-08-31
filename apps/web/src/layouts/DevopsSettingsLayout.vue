<script setup lang="ts">
import SettingsShell from "@/components/layout/SettingsShell.vue";

const tabs = [{ to: "/devops/settings/account", label: "Account" }];
</script>

<template>
  <SettingsShell title="Settings" :tabs="tabs" />
</template>
