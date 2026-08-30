/** One-time migration from pre-DB Labels settings. Not used as source of truth. */

const SETTINGS_KEY = "flow_auto_work_settings";

export type LocalSettings = {
  assignee: string | null;
  processingLabel: string;
  onStartLabels: string[];
  addLabels: string[];
  removeLabels: string[];
  comment: string;
};

export const defaultHandoffPrefs = (): LocalSettings => ({
  assignee: null,
  processingLabel: "On-processing",
  onStartLabels: [],
  addLabels: [],
  removeLabels: [],
  comment: "",
});

export function normalizeHandoffPrefs(
  p: Partial<LocalSettings> | null | undefined,
): LocalSettings {
  const d = defaultHandoffPrefs();
  if (!p) return d;
  return {
    assignee: p.assignee?.trim() || null,
    processingLabel:
      typeof p.processingLabel === "string" && p.processingLabel.trim()
        ? p.processingLabel.trim()
        : d.processingLabel,
    onStartLabels: Array.isArray(p.onStartLabels)
      ? p.onStartLabels.map((s) => String(s).trim()).filter(Boolean)
      : [],
    addLabels: Array.isArray(p.addLabels)
      ? p.addLabels.map((s) => String(s).trim()).filter(Boolean)
      : [],
    removeLabels: Array.isArray(p.removeLabels)
      ? p.removeLabels.map((s) => String(s).trim()).filter(Boolean)
      : [],
    comment: typeof p.comment === "string" ? p.comment : "",
  };
}

export function isHandoffPrefsEmpty(p: LocalSettings): boolean {
  return (
    !p.assignee &&
    !(p.addLabels?.length) &&
    !(p.removeLabels?.length) &&
    !p.comment?.trim() &&
    !(p.onStartLabels?.length) &&
    (!p.processingLabel || p.processingLabel === "On-processing")
  );
}

/** Read + clear legacy localStorage once (migrate to Mongo). */
export function consumeLegacyLocalSettings(): LocalSettings | null {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<LocalSettings>;
    const prefs = normalizeHandoffPrefs(parsed);
    localStorage.removeItem(SETTINGS_KEY);
    if (isHandoffPrefsEmpty(prefs)) return null;
    return prefs;
  } catch {
    try {
      localStorage.removeItem(SETTINGS_KEY);
    } catch {
      /* ignore */
    }
    return null;
  }
}
