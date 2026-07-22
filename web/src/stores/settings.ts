import { defineStore } from "pinia";
import { ref } from "vue";
import {
  loadLocalSettings,
  saveLocalSettings,
  type LocalSettings,
} from "@/api/settings-local";

export const useSettingsStore = defineStore("settings", () => {
  const local = ref<LocalSettings>(loadLocalSettings());

  function update(partial: Partial<LocalSettings>) {
    local.value = { ...local.value, ...partial };
    saveLocalSettings(local.value);
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

  return { local, update, completionPayload };
});
