import { ref } from "vue";
import { api } from "@/api/client";

export type CursorModelOption = { value: string; label: string };

const DEFAULT_OPTIONS: CursorModelOption[] = [{ value: "auto", label: "Auto" }];

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
        id === "auto" ? "Auto" : (m.displayName?.trim() || id),
    });
  }
  if (!seen.has("auto")) {
    out.unshift({ value: "auto", label: "Auto" });
  } else {
    const idx = out.findIndex((o) => o.value === "auto");
    if (idx > 0) {
      const [auto] = out.splice(idx, 1);
      out.unshift(auto);
    }
  }
  return out.length ? out : DEFAULT_OPTIONS;
}

export function useCursorModelSelect(modelsUrl: string) {
  const model = ref("auto");
  const models = ref<CursorModelOption[]>([...DEFAULT_OPTIONS]);
  const modelsLoading = ref(false);
  const modelsSource = ref<"cursor" | "fallback" | null>(null);
  const modelsWarning = ref<string | null>(null);

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
      }>(modelsUrlOverride ?? modelsUrl);
      if (data.models?.length) {
        models.value = toSelectOptions(data.models);
      }
      modelsSource.value = data.source ?? null;
      if (data.warning) modelsWarning.value = data.warning;
      model.value =
        data.selected?.trim() ||
        selectedFallback?.trim() ||
        "auto";
    } catch {
      models.value = [...DEFAULT_OPTIONS];
      model.value = selectedFallback?.trim() || "auto";
    } finally {
      modelsLoading.value = false;
    }
  }

  return {
    model,
    models,
    modelsLoading,
    modelsSource,
    modelsWarning,
    loadModels,
  };
}
