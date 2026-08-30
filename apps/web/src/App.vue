<script setup lang="ts">
import { computed } from "vue";
import { theme as antTheme, ConfigProvider } from "ant-design-vue";
import { RouterView } from "vue-router";
import { useThemeStore } from "@/stores/theme";

const themeStore = useThemeStore();

const sharedToken = {
  borderRadius: 6,
  fontFamily:
    '"IBM Plex Sans", system-ui, -apple-system, "Segoe UI", sans-serif',
  fontSize: 13,
  controlHeight: 28,
  controlHeightSM: 24,
};

const darkToken = {
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
};

const lightToken = {
  colorPrimary: "#3B6FD1",
  colorInfo: "#3B6FD1",
  colorSuccess: "#0EA56E",
  colorWarning: "#C4880A",
  colorError: "#D63A54",
  colorText: "#111827",
  colorTextSecondary: "#333E4D",
  colorTextTertiary: "#525E6E",
  colorBgBase: "#F3F5F8",
  colorBgContainer: "#FFFFFF",
  colorBgElevated: "#FFFFFF",
  colorBgLayout: "#F3F5F8",
  colorBorder: "#DDE2EA",
  colorBorderSecondary: "#E7EBF1",
};

const themeConfig = computed(() =>
  themeStore.mode === "light"
    ? {
        algorithm: antTheme.defaultAlgorithm,
        token: { ...sharedToken, ...lightToken },
      }
    : {
        algorithm: antTheme.darkAlgorithm,
        token: { ...sharedToken, ...darkToken },
      },
);
</script>

<template>
  <ConfigProvider :theme="themeConfig">
    <div class="h-[100dvh] max-h-[100dvh] overflow-hidden text-ink text-[13px] leading-[1.45]">
      <RouterView />
    </div>
  </ConfigProvider>
</template>
