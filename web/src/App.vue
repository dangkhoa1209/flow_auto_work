<script setup lang="ts">
import { computed } from "vue";
import { theme as antTheme, ConfigProvider } from "ant-design-vue";
import { RouterView } from "vue-router";

const themeConfig = computed(() => ({
  algorithm: antTheme.darkAlgorithm,
  token: {
    colorPrimary: "#5B8DEF",
    colorInfo: "#5B8DEF",
    colorSuccess: "#34D399",
    colorWarning: "#F0B429",
    colorError: "#F0576B",
    colorText: "#E7E9EE",
    colorTextSecondary: "#9AA2B1",
    colorTextTertiary: "#5E6576",
    colorBgBase: "#0D0F14",
    colorBgContainer: "#12151C",
    colorBgElevated: "#171B24",
    colorBgLayout: "#0D0F14",
    colorBorder: "#232833",
    colorBorderSecondary: "#232833",
    borderRadius: 6,
    fontFamily:
      '"IBM Plex Sans", system-ui, -apple-system, "Segoe UI", sans-serif',
    fontSize: 13,
    controlHeight: 28,
    controlHeightSM: 24,
  },
}));
</script>

<template>
  <ConfigProvider :theme="themeConfig">
    <div class="h-[100dvh] max-h-[100dvh] overflow-hidden text-ink text-[13px] leading-[1.45]">
      <RouterView />
    </div>
  </ConfigProvider>
</template>
