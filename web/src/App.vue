<script setup lang="ts">
import { computed } from "vue";
import { theme as antTheme, ConfigProvider } from "ant-design-vue";
import { RouterView } from "vue-router";

const themeConfig = computed(() => ({
  algorithm: antTheme.defaultAlgorithm,
  token: {
    colorPrimary: "#0f766e",
    colorInfo: "#0891b2",
    colorSuccess: "#059669",
    colorWarning: "#d97706",
    colorError: "#dc2626",
    colorText: "#0f172a",
    colorTextSecondary: "#475569",
    colorTextTertiary: "#64748b",
    colorBgBase: "#eef3f9",
    colorBgContainer: "#ffffff",
    colorBgElevated: "#ffffff",
    colorBgLayout: "#eef3f9",
    colorBorder: "#d7e0ec",
    colorBorderSecondary: "#e8eef6",
    borderRadius: 10,
    fontFamily: 'Sora, Outfit, system-ui, sans-serif',
    controlHeight: 36,
  },
}));
</script>

<template>
  <ConfigProvider :theme="themeConfig">
    <div class="h-full max-h-full overflow-hidden text-ink">
      <RouterView />
    </div>
  </ConfigProvider>
</template>
