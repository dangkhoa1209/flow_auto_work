<script setup lang="ts">
import { useCursorModelSelect } from "@/composables/useCursorModelSelect";

const props = defineProps<{
  modelsUrl: string;
  selectedFallback?: string | null;
  loading?: boolean;
  saveLabel?: string;
}>();

const emit = defineEmits<{
  save: [storedValue: string];
}>();

const {
  modelId,
  routerMode,
  storedValue,
  isRouterSelected,
  models,
  routerModes,
  modelsLoading,
  modelsWarning,
  loadModels,
} = useCursorModelSelect(props.modelsUrl);

async function loadModelsForPat(
  patId?: string | null,
  selectedFallback?: string | null,
) {
  const url = patId
    ? `${props.modelsUrl}?patId=${encodeURIComponent(patId)}`
    : props.modelsUrl;
  await loadModels(selectedFallback ?? storedValue.value, url);
}

function onSave() {
  emit("save", storedValue.value);
}

defineExpose({
  loadModelsForPat,
  storedValue,
});
</script>

<template>
  <div class="space-y-3">
    <label class="flex flex-col gap-1 text-sm">
      <span class="text-ink-muted">Agent model</span>
      <a-select
        v-model:value="modelId"
        :loading="modelsLoading"
        show-search
        option-filter-prop="label"
        option-label-prop="label"
        class="w-full max-w-md"
      >
        <a-select-option
          v-for="m in models"
          :key="m.value"
          :value="m.value"
          :label="m.label"
        >
          {{ m.label }}
        </a-select-option>
      </a-select>
    </label>
    <label v-if="isRouterSelected" class="flex flex-col gap-1 text-sm">
      <span class="text-ink-muted">Router mode</span>
      <a-select
        v-model:value="routerMode"
        option-label-prop="label"
        class="w-full max-w-md"
      >
        <a-select-option
          v-for="mode in routerModes"
          :key="mode.value"
          :value="mode.value"
          :label="mode.label"
        >
          {{ mode.label }}
        </a-select-option>
      </a-select>
      <span class="text-xs text-ink-faint">
        Cost saves tokens; Balanced is default for most jobs; Intelligence for
        complex refactors only.
      </span>
    </label>
    <a-alert
      v-if="modelsWarning"
      type="warning"
      show-icon
      :message="modelsWarning"
    />
    <a-button
      size="small"
      type="primary"
      :loading="loading || modelsLoading"
      @click="onSave"
    >
      {{ saveLabel ?? "Save model" }}
    </a-button>
  </div>
</template>
