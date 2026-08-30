import { ref } from "vue";
import { defineStore } from "pinia";

export type ThemeMode = "dark" | "light";

const STORAGE_KEY = "flow_theme";

export function readStoredTheme(): ThemeMode {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "light" || v === "dark") return v;
  } catch {
    /* storage unavailable */
  }
  return "dark";
}

export function applyThemeToDocument(mode: ThemeMode): void {
  document.documentElement.dataset.theme = mode;
}

export const useThemeStore = defineStore("theme", () => {
  const mode = ref<ThemeMode>(readStoredTheme());
  applyThemeToDocument(mode.value);

  function set(next: ThemeMode) {
    mode.value = next;
    applyThemeToDocument(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* storage unavailable */
    }
  }

  function toggle() {
    set(mode.value === "dark" ? "light" : "dark");
  }

  return { mode, set, toggle };
});
