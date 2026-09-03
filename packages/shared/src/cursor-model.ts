/** Canonical Auto/Router id from `Cursor.models.list()` (SDK 1.x). */
export const CURSOR_ROUTER_MODEL_ID = "default";
/** Docs/UI name that is not in the current SDK catalog. */
export const LEGACY_ROUTER_MODEL_ID = "auto-smart";
export const LEGACY_AUTO_MODEL_ID = "auto";

export type CursorRouterMode = "cost" | "balanced" | "intelligence";

export type CursorModelParam = { id: string; value: string };

export type CursorModelSpec = {
  id: string;
  params?: CursorModelParam[];
};

export const ROUTER_MODE_LABELS: Record<CursorRouterMode, string> = {
  cost: "Cost",
  balanced: "Balanced",
  intelligence: "Intelligence",
};

export const DEFAULT_ROUTER_MODES: CursorRouterMode[] = [
  "cost",
  "balanced",
  "intelligence",
];

export const DEFAULT_ROUTER_MODE: CursorRouterMode = "cost";

export function isRouterMode(value: string): value is CursorRouterMode {
  return (
    value === "cost" || value === "balanced" || value === "intelligence"
  );
}

/** Stored or listed ids that mean Cursor Auto / Router (not a pinned model). */
export function isRouterModelId(id: string): boolean {
  return id === CURSOR_ROUTER_MODEL_ID || id === LEGACY_ROUTER_MODEL_ID;
}

/** Stored value → settings object (`default:cost` / `auto-smart:cost` encode mode). */
export function parseCursorModel(raw?: string | null): CursorModelSpec {
  const trimmed = raw?.trim() || LEGACY_AUTO_MODEL_ID;
  const colon = trimmed.indexOf(":");
  if (colon > 0) {
    const id = trimmed.slice(0, colon).trim();
    const suffix = trimmed.slice(colon + 1).trim();
    if (isRouterModelId(id) && isRouterMode(suffix)) {
      return {
        id,
        params: [{ id: "optimize_for", value: suffix }],
      };
    }
  }
  return { id: trimmed };
}

/** SDK model object → stored value for DB / settings. */
export function serializeCursorModel(spec: CursorModelSpec): string {
  const id = spec.id.trim() || LEGACY_AUTO_MODEL_ID;
  const mode = spec.params?.find((p) => p.id === "optimize_for")?.value;
  if (isRouterModelId(id) && mode && isRouterMode(mode)) {
    return `${id}:${mode}`;
  }
  return id;
}

/**
 * Stored settings → Cursor SDK `model` field.
 * Maps `auto` / `auto-smart` onto catalog id `default`.
 */
export function toSdkCursorModel(raw?: string | null): CursorModelSpec {
  const spec = parseCursorModel(raw);
  if (spec.id === LEGACY_AUTO_MODEL_ID || isRouterModelId(spec.id)) {
    return {
      id: CURSOR_ROUTER_MODEL_ID,
      params: spec.params,
    };
  }
  return spec;
}

/** If the catalog has no `auto-smart`, bind stored Router values to `default`. */
export function resolveListedRouterModelId(
  storedModelId: string,
  listedIds: Iterable<string>,
): string {
  const listed = new Set(
    [...listedIds].map((id) => id.trim()).filter(Boolean),
  );
  if (listed.has(storedModelId)) return storedModelId;
  if (isRouterModelId(storedModelId) && listed.has(CURSOR_ROUTER_MODEL_ID)) {
    return CURSOR_ROUTER_MODEL_ID;
  }
  return storedModelId;
}

/** Human-readable label for logs and UI hints. */
export function formatCursorModelLabel(raw?: string | null): string {
  const spec = parseCursorModel(raw);
  if (spec.id === LEGACY_AUTO_MODEL_ID) return "Auto";
  if (isRouterModelId(spec.id)) {
    const mode = spec.params?.find((p) => p.id === "optimize_for")?.value;
    if (mode && isRouterMode(mode)) {
      return `Auto (Router · ${ROUTER_MODE_LABELS[mode]})`;
    }
    return "Auto (Router)";
  }
  return spec.id;
}

export function splitStoredCursorModel(raw?: string | null): {
  modelId: string;
  routerMode: CursorRouterMode | null;
} {
  const spec = parseCursorModel(raw);
  if (!isRouterModelId(spec.id)) {
    return { modelId: spec.id, routerMode: null };
  }
  const mode = spec.params?.find((p) => p.id === "optimize_for")?.value;
  return {
    modelId: spec.id,
    routerMode: mode && isRouterMode(mode) ? mode : DEFAULT_ROUTER_MODE,
  };
}

export function combineStoredCursorModel(
  modelId: string,
  routerMode?: CursorRouterMode | null,
): string {
  const id = modelId.trim() || LEGACY_AUTO_MODEL_ID;
  return serializeCursorModel({
    id,
    params:
      isRouterModelId(id) && routerMode
        ? [{ id: "optimize_for", value: routerMode }]
        : undefined,
  });
}
