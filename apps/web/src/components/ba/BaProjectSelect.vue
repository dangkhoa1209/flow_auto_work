<script setup lang="ts">
import { computed } from "vue";
import { message } from "ant-design-vue";
import { useBaChatStore, type BaProject } from "@/stores/baChat";

const props = withDefaults(
  defineProps<{
    size?: "small" | "middle" | "large";
    block?: boolean;
    showLabel?: boolean;
  }>(),
  {
    size: "small",
    block: true,
    showLabel: true,
  },
);

const ba = useBaChatStore();

const projectId = computed({
  get: () => ba.selectedProjectId ?? undefined,
  set: (id: string | undefined) => {
    if (!id || id === ba.selectedProjectId) return;
    void onChange(id);
  },
});

function projectLabel(p: BaProject): string {
  if (p.ready) return p.displayName;
  return `${p.displayName} (${p.cloneStatus})`;
}

async function onChange(id: string) {
  try {
    await ba.selectProject(id);
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  }
}
</script>

<template>
  <div :class="block ? 'w-full' : ''">
    <label v-if="showLabel" class="faw-ba-label block mb-1">Project</label>
    <a-select
      v-model:value="projectId"
      placeholder="Select project"
      :class="block ? 'w-full faw-ba-select' : 'faw-ba-select'"
      :size="size"
      :disabled="!ba.projects.length"
      show-search
      option-filter-prop="label"
    >
      <a-select-option
        v-for="p in ba.projects"
        :key="p.id"
        :value="p.id"
        :label="projectLabel(p)"
        :disabled="!p.ready"
      >
        <span class="inline-flex items-center gap-1.5 min-w-0">
          <span class="truncate">{{ projectLabel(p) }}</span>
          <span
            v-if="p.db?.enabled"
            class="ba-db-dot shrink-0"
            title="DB connected"
          />
        </span>
      </a-select-option>
    </a-select>
  </div>
</template>

<style scoped>
.ba-db-dot {
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: var(--app-accent, #22c55e);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--app-accent, #22c55e) 40%, transparent);
}
</style>
