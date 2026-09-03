export const CURSOR_ROUTER_MODEL_ID = "auto-smart";
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

/** Stored value → SDK model object (`auto-smart:cost` encodes Router mode). */
export function parseCursorModel(raw?: string | null): CursorModelSpec {
  const trimmed = raw?.trim() || LEGACY_AUTO_MODEL_ID;
  const colon = trimmed.indexOf(":");
  if (colon > 0) {
    const id = trimmed.slice(0, colon).trim();
    const suffix = trimmed.slice(colon + 1).trim();
    if (id === CURSOR_ROUTER_MODEL_ID && isRouterMode(suffix)) {
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
  if (id === CURSOR_ROUTER_MODEL_ID && mode && isRouterMode(mode)) {
    return `${id}:${mode}`;
  }
  return id;
}

/** Human-readable label for logs and UI hints. */
export function formatCursorModelLabel(raw?: string | null): string {
  const spec = parseCursorModel(raw);
  if (spec.id === LEGACY_AUTO_MODEL_ID) return "Auto";
  if (spec.id === CURSOR_ROUTER_MODEL_ID) {
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
  if (spec.id !== CURSOR_ROUTER_MODEL_ID) {
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
  return serializeCursorModel({
    id: modelId.trim() || LEGACY_AUTO_MODEL_ID,
    params:
      modelId === CURSOR_ROUTER_MODEL_ID && routerMode
        ? [{ id: "optimize_for", value: routerMode }]
        : undefined,
  });
}
