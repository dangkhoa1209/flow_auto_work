import { Cursor } from "@cursor/sdk";

export const AUTO_CURSOR_MODEL = { id: "auto", displayName: "Auto" } as const;

export const FALLBACK_CURSOR_MODELS: { id: string; displayName: string }[] = [
  AUTO_CURSOR_MODEL,
  { id: "composer-2.5", displayName: "Composer 2.5" },
];

export type CursorModelListResult = {
  models: { id: string; displayName: string }[];
  source: "cursor" | "fallback";
  selected: string;
  warning?: string;
};

/** List Cursor models for an API key. Always includes `auto` first. */
export async function listCursorModelsForApiKey(
  apiKey: string,
  selectedRaw?: string | null,
): Promise<CursorModelListResult> {
  const selected = selectedRaw?.trim() || "auto";
  const key = apiKey.trim();
  if (!key) {
    return {
      models: FALLBACK_CURSOR_MODELS,
      source: "fallback",
      selected,
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
    const seen = new Set(["auto"]);
    for (const item of raw) {
      const m = item as { id?: string; displayName?: string; name?: string };
      const id = (m.id || "").trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      models.push({ id, displayName: m.displayName || m.name || id });
    }
    return { models, source: "cursor", selected };
  } catch (err) {
    return {
      models: FALLBACK_CURSOR_MODELS,
      source: "fallback",
      selected,
      warning: err instanceof Error ? err.message : String(err),
    };
  }
}
