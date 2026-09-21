<script setup lang="ts">
import { computed } from "vue";
import { theme as antTheme, ConfigProvider } from "ant-design-vue";
import { RouterView } from "vue-router";
import { useThemeStore } from "@/stores/theme";

const themeStore = useThemeStore();

const sharedToken = {
  borderRadius: 6,
  fontFamily:
    '"Montserrat", system-ui, -apple-system, "Segoe UI", sans-serif',
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
  colorPrimary: "#2563C7",
  colorInfo: "#2563C7",
  colorSuccess: "#047857",
  colorWarning: "#B45309",
  colorError: "#DC2626",
  colorText: "#0F172A",
  colorTextSecondary: "#2D3748",
  colorTextTertiary: "#475569",
  colorBgBase: "#E8ECF2",
  colorBgContainer: "#FFFFFF",
  colorBgElevated: "#FFFFFF",
  colorBgLayout: "#E8ECF2",
  colorBorder: "#C4CDDA",
  colorBorderSecondary: "#CFD6E2",
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
