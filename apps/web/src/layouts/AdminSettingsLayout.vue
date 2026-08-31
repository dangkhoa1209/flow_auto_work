<script setup lang="ts">
import SettingsShell from "@/components/layout/SettingsShell.vue";

const tabs = [{ to: "/admin/settings/account", label: "Account" }];
</script>

<template>
  <SettingsShell title="Settings" :tabs="tabs" />
</template>
