<script setup lang="ts">
import { computed } from "vue";
import { message } from "ant-design-vue";
import { useBaChatStore, type BaProject } from "@/stores/baChat";

const props = withDefaults(
  defineProps<{
    size?: "small" | "middle" | "large";
    block?: boolean;
    showLabel?: boolean;
    /** Nest inside `.faw-crumb` — no second border on the select. */
    embedded?: boolean;
  }>(),
  {
    size: "small",
    block: true,
    showLabel: true,
    embedded: false,
  },
);

const ba = useBaChatStore();

const selectClass = computed(() => {
  const skin = props.embedded ? "faw-crumb-select" : "faw-ba-select";
  return props.block ? `w-full ${skin}` : skin;
});

const projectId = computed({
  get: () => ba.selectedProjectId ?? undefined,
  set: (id: string | undefined) => {
    if (!id || id === ba.selectedProjectId) return;
    void onChange(id);
  },
});

function isProjectReady(p: BaProject): boolean {
  return Boolean(p.ready) || p.cloneStatus === "ready";
}

/** Name only when ready; otherwise append clone status. */
function projectLabel(p: BaProject): string {
  if (isProjectReady(p)) return p.displayName;
  const status = (p.cloneStatus || "").trim();
  return status ? `${p.displayName} (${status})` : p.displayName;
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
      :class="selectClass"
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
      >
        <span class="inline-flex items-center gap-1.5 min-w-0">
          <span class="truncate">{{ p.displayName }}</span>
          <span
            v-if="!isProjectReady(p) && p.cloneStatus"
            class="faw-ba-project-status shrink-0"
          >
            {{ p.cloneStatus }}
          </span>
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
.faw-ba-project-status {
  font-size: 11px;
  color: var(--app-faint, var(--app-muted));
  font-family: var(--font-mono, ui-monospace, monospace);
}
.ba-db-dot {
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: var(--app-accent, #22c55e);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--app-accent, #22c55e) 40%, transparent);
}
</style>
