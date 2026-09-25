<script setup lang="ts">
import { computed } from "vue";
import { brandLogoSrc, BRAND_LOGO } from "@/lib/brandAssets";
import { useThemeStore } from "@/stores/theme";

const props = withDefaults(
  defineProps<{
    variant?: "full" | "mark";
    alt?: string;
    width?: number | string;
    height?: number | string;
  }>(),
  {
    variant: "full",
  },
);

const themeStore = useThemeStore();

const src = computed(() =>
  props.variant === "mark"
    ? BRAND_LOGO.mark
    : brandLogoSrc(themeStore.mode),
);

const resolvedAlt = computed(
  () =>
    props.alt ??
    (props.variant === "mark" ? "FLOW.AUTO" : "Flow Auto WorkBench"),
);
</script>

<template>
  <img
    :src="src"
    :alt="resolvedAlt"
    :width="width"
    :height="height"
    draggable="false"
  />
</template>
