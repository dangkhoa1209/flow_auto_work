const SETTINGS_KEY = "flow_auto_work_settings";

export type LocalSettings = {
  assignee: string | null;
  processingLabel: string;
  onStartLabels: string[];
  addLabels: string[];
  removeLabels: string[];
  comment: string;
};

const defaults: LocalSettings = {
  assignee: null,
  processingLabel: "On-processing",
  onStartLabels: [],
  addLabels: [],
  removeLabels: [],
  comment: "",
};

export function loadLocalSettings(): LocalSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...defaults };
    const parsed = JSON.parse(raw) as Partial<LocalSettings>;
    return {
      assignee: parsed.assignee || null,
      processingLabel:
        typeof parsed.processingLabel === "string" &&
        parsed.processingLabel.trim()
          ? parsed.processingLabel.trim()
          : "On-processing",
      onStartLabels: Array.isArray(parsed.onStartLabels)
        ? parsed.onStartLabels
        : [],
      addLabels: Array.isArray(parsed.addLabels) ? parsed.addLabels : [],
      removeLabels: Array.isArray(parsed.removeLabels)
        ? parsed.removeLabels
        : [],
      comment: parsed.comment || "",
    };
  } catch {
    return { ...defaults };
  }
}

export function saveLocalSettings(s: LocalSettings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}
