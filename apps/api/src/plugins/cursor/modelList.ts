import {
  CURSOR_ROUTER_MODEL_ID,
  DEFAULT_ROUTER_MODES,
  isRouterMode,
  isRouterModelId,
  LEGACY_AUTO_MODEL_ID,
  ROUTER_MODE_LABELS,
  toUiRouterModelId,
  type CursorRouterMode,
} from "@flow/shared";
import { Cursor } from "@cursor/sdk";

export const AUTO_CURSOR_MODEL = {
  id: LEGACY_AUTO_MODEL_ID,
  displayName: "Auto (legacy)",
} as const;

export const ROUTER_CURSOR_MODEL = {
  id: CURSOR_ROUTER_MODEL_ID,
  displayName: "Auto (Router)",
} as const;

export const FALLBACK_CURSOR_MODELS: { id: string; displayName: string }[] = [
  AUTO_CURSOR_MODEL,
  ROUTER_CURSOR_MODEL,
  { id: "composer-2.5", displayName: "Composer 2.5" },
];

export type CursorRouterModeOption = { value: CursorRouterMode; label: string };

export type CursorModelListResult = {
  models: { id: string; displayName: string }[];
  source: "cursor" | "fallback";
  selected: string;
  routerModes: CursorRouterModeOption[];
  warning?: string;
};

function defaultRouterModes(): CursorRouterModeOption[] {
  return DEFAULT_ROUTER_MODES.map((value) => ({
    value,
    label: ROUTER_MODE_LABELS[value],
  }));
}

function paramValueIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item === "string" && item.trim()) {
      out.push(item.trim());
      continue;
    }
    if (item && typeof item === "object" && "value" in item) {
      const value = String((item as { value?: unknown }).value ?? "").trim();
      if (value) out.push(value);
    }
  }
  return out;
}

function extractRouterModes(raw: unknown[]): CursorRouterModeOption[] {
  const router = raw.find((item) => {
    const m = item as { id?: string; aliases?: string[] };
    const id = m.id?.trim() ?? "";
    if (isRouterModelId(id)) return true;
    return (m.aliases ?? []).some((alias) => isRouterModelId(alias.trim()));
  }) as
    | {
        parameters?: Array<{
          id?: string;
          values?: unknown;
          allowedValues?: unknown;
        }>;
      }
    | undefined;

  const param = router?.parameters?.find((p) => p.id === "optimize_for");
  const values = paramValueIds(param?.values ?? param?.allowedValues);
  const modes = values.filter(isRouterMode);
  if (!modes.length) return defaultRouterModes();
  return modes.map((value) => ({
    value,
    label: ROUTER_MODE_LABELS[value],
  }));
}

function displayNameFor(id: string, listedName?: string): string {
  if (id === LEGACY_AUTO_MODEL_ID) return AUTO_CURSOR_MODEL.displayName;
  if (isRouterModelId(id)) return ROUTER_CURSOR_MODEL.displayName;
  return listedName?.trim() || id;
}

/** List Cursor models for an API key. Always includes `auto` first. */
export async function listCursorModelsForApiKey(
  apiKey: string,
  selectedRaw?: string | null,
): Promise<CursorModelListResult> {
  const selected = selectedRaw?.trim() || LEGACY_AUTO_MODEL_ID;
  const key = apiKey.trim();
  if (!key) {
    return {
      models: FALLBACK_CURSOR_MODELS,
      source: "fallback",
      selected,
      routerModes: defaultRouterModes(),
    };
  }
  try {
    const listed = await Cursor.models.list({ apiKey: key });
    const raw = Array.isArray(listed)
      ? listed
      : Array.isArray((listed as { models?: unknown }).models)
        ? (listed as { models: unknown[] }).models
        : [];
    const models: { id: string; displayName: string }[] = [AUTO_CURSOR_MODEL];
    const seen = new Set<string>([LEGACY_AUTO_MODEL_ID]);
    for (const item of raw) {
      const m = item as { id?: string; displayName?: string; name?: string };
      const rawId = (m.id || "").trim();
      const id = rawId ? toUiRouterModelId(rawId) : "";
      if (!id || seen.has(id)) continue;
      seen.add(id);
      models.push({
        id,
        displayName: displayNameFor(id, m.displayName || m.name),
      });
    }
    return {
      models,
      source: "cursor",
      selected,
      routerModes: extractRouterModes(raw),
    };
  } catch (err) {
    return {
      models: FALLBACK_CURSOR_MODELS,
      source: "fallback",
      selected,
      routerModes: defaultRouterModes(),
      warning: err instanceof Error ? err.message : String(err),
    };
  }
}
