import { computed, ref } from "vue";
import {
  combineStoredCursorModel,
  CURSOR_ROUTER_MODEL_ID,
  DEFAULT_ROUTER_MODE,
  LEGACY_AUTO_MODEL_ID,
  splitStoredCursorModel,
  type CursorRouterMode,
} from "@flow/shared";
import { api } from "@/api/client";

export type CursorModelOption = { value: string; label: string };
export type CursorRouterModeOption = { value: CursorRouterMode; label: string };

const DEFAULT_OPTIONS: CursorModelOption[] = [
  { value: LEGACY_AUTO_MODEL_ID, label: "Auto (legacy)" },
];

const DEFAULT_ROUTER_MODES: CursorRouterModeOption[] = [
  { value: "cost", label: "Cost" },
  { value: "balanced", label: "Balanced" },
  { value: "intelligence", label: "Intelligence" },
];

function toSelectOptions(
  models: Array<{ id: string; displayName?: string }>,
): CursorModelOption[] {
  const seen = new Set<string>();
  const out: CursorModelOption[] = [];
  for (const m of models) {
    const id = m.id.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({
      value: id,
      label:
        id === LEGACY_AUTO_MODEL_ID
          ? "Auto (legacy)"
          : m.displayName?.trim() || id,
    });
  }
  if (!seen.has(LEGACY_AUTO_MODEL_ID)) {
    out.unshift({ value: LEGACY_AUTO_MODEL_ID, label: "Auto (legacy)" });
  } else {
    const idx = out.findIndex((o) => o.value === LEGACY_AUTO_MODEL_ID);
    if (idx > 0) {
      const [auto] = out.splice(idx, 1);
      out.unshift(auto);
    }
  }
  return out.length ? out : DEFAULT_OPTIONS;
}

function applyStoredSelection(
  stored: string | null | undefined,
  model: { value: string },
  routerMode: { value: CursorRouterMode },
) {
  const split = splitStoredCursorModel(stored);
  model.value = split.modelId;
  routerMode.value = split.routerMode ?? DEFAULT_ROUTER_MODE;
}

export function useCursorModelSelect(modelsUrl: string) {
  const modelId = ref(LEGACY_AUTO_MODEL_ID);
  const routerMode = ref<CursorRouterMode>(DEFAULT_ROUTER_MODE);
  const models = ref<CursorModelOption[]>([...DEFAULT_OPTIONS]);
  const routerModes = ref<CursorRouterModeOption[]>([...DEFAULT_ROUTER_MODES]);
  const modelsLoading = ref(false);
  const modelsSource = ref<"cursor" | "fallback" | null>(null);
  const modelsWarning = ref<string | null>(null);

  const isRouterSelected = computed(
    () => modelId.value === CURSOR_ROUTER_MODEL_ID,
  );

  const storedValue = computed(() =>
    combineStoredCursorModel(modelId.value, routerMode.value),
  );

  async function loadModels(
    selectedFallback?: string | null,
    modelsUrlOverride?: string,
  ) {
    modelsLoading.value = true;
    modelsWarning.value = null;
    try {
      const data = await api<{
        models?: Array<{ id: string; displayName?: string }>;
        selected?: string;
        source?: "cursor" | "fallback";
        warning?: string;
        routerModes?: CursorRouterModeOption[];
      }>(modelsUrlOverride ?? modelsUrl);
      if (data.models?.length) {
        models.value = toSelectOptions(data.models);
      }
      if (data.routerModes?.length) {
        routerModes.value = data.routerModes;
      }
      modelsSource.value = data.source ?? null;
      if (data.warning) modelsWarning.value = data.warning;
      applyStoredSelection(
        data.selected?.trim() || selectedFallback?.trim() || LEGACY_AUTO_MODEL_ID,
        modelId,
        routerMode,
      );
    } catch {
      models.value = [...DEFAULT_OPTIONS];
      applyStoredSelection(
        selectedFallback?.trim() || LEGACY_AUTO_MODEL_ID,
        modelId,
        routerMode,
      );
    } finally {
      modelsLoading.value = false;
    }
  }

  return {
    modelId,
    routerMode,
    storedValue,
    isRouterSelected,
    models,
    routerModes,
    modelsLoading,
    modelsSource,
    modelsWarning,
    loadModels,
  };
}
