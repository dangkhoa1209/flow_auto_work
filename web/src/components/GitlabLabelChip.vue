<script setup lang="ts">
import { computed } from "vue";
import { useWorkStore } from "@/stores/work";
import { gitlabLabelChipStyle } from "@/utils/gitlabLabel";

const props = defineProps<{
  name: string;
  title?: string;
}>();

const work = useWorkStore();

const chipStyle = computed(() =>
  gitlabLabelChipStyle(work.labelCatalog[props.name]),
);
</script>

<template>
  <span
    class="faw-chip"
    :class="{ 'faw-chip--gl': Boolean(chipStyle) }"
    :style="chipStyle"
    :title="title || name"
    >{{ name }}</span
  >
</template>
