<script setup lang="ts">
import { computed } from "vue";
import { theme as antTheme, ConfigProvider } from "ant-design-vue";
import { RouterView } from "vue-router";

const themeConfig = computed(() => ({
  algorithm: antTheme.darkAlgorithm,
  token: {
    colorPrimary: "#5B8DEF",
    borderRadius: 6,
    fontFamily: '"IBM Plex Sans", system-ui, sans-serif',
    fontSize: 13,
  },
}));
</script>

<template>
  <ConfigProvider :theme="themeConfig">
    <div class="h-full min-h-[100dvh] text-ink">
      <RouterView />
    </div>
  </ConfigProvider>
</template>
