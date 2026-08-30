import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { API } from "@/api/endpoints";
import { api } from "@/api/client";
import {
  consumeLegacyLocalSettings,
  defaultHandoffPrefs,
  isHandoffPrefsEmpty,
  normalizeHandoffPrefs,
  type LocalSettings,
} from "@/api/settings-local";

/**
 * Settings store — source of truth is MongoDB via API.
 * (Cursor / Project / Account are already server-backed elsewhere.)
 */
export const useSettingsStore = defineStore("settings", () => {
  const local = ref<LocalSettings>(defaultHandoffPrefs());
  const loadedProjectId = ref<string | null>(null);
  const loading = ref(false);

  const hasHandoffPrefs = computed(() => !isHandoffPrefsEmpty(local.value));

  function update(partial: Partial<LocalSettings>) {
    local.value = normalizeHandoffPrefs({ ...local.value, ...partial });
  }

  /** Load Labels & handoff prefs from DB for the active project. */
  async function loadHandoffPrefs(projectId?: string | null) {
    const pid = (projectId || "").trim();
    if (!pid) return;
    loading.value = true;
    try {
      const data = await api<{ prefs?: Partial<LocalSettings> }>(
        `${API.me.handoffPrefs}?projectId=${encodeURIComponent(pid)}`,
      );
      let prefs = normalizeHandoffPrefs(data.prefs);

      // One-time migrate: old browser localStorage → DB
      if (isHandoffPrefsEmpty(prefs)) {
        const legacy = consumeLegacyLocalSettings();
        if (legacy) {
          await api(API.me.handoffPrefs, {
            method: "PUT",
            body: JSON.stringify({ projectId: pid, prefs: legacy }),
          });
          prefs = legacy;
        }
      } else {
        // Drop stale local cache if any
        consumeLegacyLocalSettings();
      }

      local.value = prefs;
      loadedProjectId.value = pid;
    } catch {
      // keep in-memory defaults / last loaded
    } finally {
      loading.value = false;
    }
  }

  async function saveHandoffPrefs(projectId?: string | null) {
    const pid = (projectId || "").trim();
    if (!pid) throw new Error("Select a project first");
    const prefs = normalizeHandoffPrefs(local.value);
    local.value = prefs;
    const res = await api<{ prefs?: Partial<LocalSettings> }>(
      API.me.handoffPrefs,
      {
        method: "PUT",
        body: JSON.stringify({ projectId: pid, prefs }),
      },
    );
    if (res.prefs) local.value = normalizeHandoffPrefs(res.prefs);
    loadedProjectId.value = pid;
    consumeLegacyLocalSettings();
  }

  function completionPayload() {
    return {
      assignees: [] as string[],
      labels: [] as string[],
      removeLabels: [] as string[],
      onStartLabels: local.value.onStartLabels || [],
      processingLabel: local.value.processingLabel || "On-processing",
      labelMode: "add" as const,
      comment: "",
    };
  }

  return {
    local,
    loading,
    loadedProjectId,
    hasHandoffPrefs,
    update,
    loadHandoffPrefs,
    saveHandoffPrefs,
    completionPayload,
  };
});
