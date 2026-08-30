<script setup lang="ts">
import { onMounted, ref } from "vue";
import { message } from "ant-design-vue";
import { api } from "@/api/client";
import { API } from "@/api/endpoints";
import { useCursorModelSelect } from "@/composables/useCursorModelSelect";

const loading = ref(false);
const hasKey = ref(false);
const cursorKey = ref("");
const {
  model,
  models,
  modelsLoading,
  modelsWarning,
  loadModels,
} = useCursorModelSelect(API.admin.cursorModels);

async function load() {
  try {
    const data = await api<{
      hasCursorApiKey?: boolean;
      cursorModel?: string;
    }>(API.admin.cursorSettings);
    hasKey.value = Boolean(data.hasCursorApiKey);
    await loadModels(data.cursorModel || "auto");
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  }
}

async function saveKey() {
  if (!cursorKey.value.trim()) {
    message.warning("Paste Cursor API key");
    return;
  }
  loading.value = true;
  try {
    await api(API.admin.cursorSettings, {
      method: "PUT",
      body: JSON.stringify({ cursorApiKey: cursorKey.value.trim() }),
    });
    cursorKey.value = "";
    message.success("Shared Cursor key saved");
    await load();
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  } finally {
    loading.value = false;
  }
}

async function saveModel() {
  loading.value = true;
  try {
    await api(API.admin.cursorSettings, {
      method: "PUT",
      body: JSON.stringify({ cursorModel: model.value }),
    });
    message.success("Model saved");
    await load();
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  } finally {
    loading.value = false;
  }
}

async function clearKey() {
  loading.value = true;
  try {
    await api(API.admin.cursorSettings, {
      method: "PUT",
      body: JSON.stringify({ cursorApiKey: null }),
    });
    message.success("Key removed");
    await load();
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  void load();
});
</script>

<template>
  <div class="max-w-xl mx-auto px-4 py-6">
    <h1 class="text-xl font-semibold text-ink m-0 mb-1">Shared Cursor key</h1>
    <p class="text-sm text-ink-muted mb-6">
      One API key for all BA Chat agent runs across projects.
    </p>

    <div class="p-4 rounded-lg border border-line bg-surface-raised space-y-4">
      <div class="text-sm">
        Status:
        <span :class="hasKey ? 'text-green-700' : 'text-orange-600'">
          {{ hasKey ? "Key configured" : "No key yet" }}
        </span>
      </div>

      <label class="flex flex-col gap-1 text-sm">
        <span class="text-ink-muted">Cursor API key</span>
        <a-input-password
          v-model:value="cursorKey"
          placeholder="key_…"
        />
      </label>
      <button
        type="button"
        class="faw-btn faw-btn--run"
        :disabled="loading"
        @click="saveKey"
      >
        {{ loading ? "Saving…" : "Save key" }}
      </button>
      <button
        v-if="hasKey"
        type="button"
        class="ml-2 text-sm text-red-600 hover:underline"
        :disabled="loading"
        @click="clearKey"
      >
        Remove key
      </button>

      <div class="pt-2 border-t border-line space-y-3">
        <label class="flex flex-col gap-1 text-sm">
          <span class="text-ink-muted">Agent model</span>
          <a-select
            v-model:value="model"
            :options="models"
            :loading="modelsLoading"
            class="w-full"
          />
        </label>
        <a-alert
          v-if="modelsWarning"
          type="warning"
          show-icon
          :message="modelsWarning"
        />
        <button
          type="button"
          class="px-3 py-1.5 text-sm border border-line rounded-md hover:border-accent"
          :disabled="loading"
          @click="saveModel"
        >
          Save model
        </button>
      </div>
    </div>
  </div>
</template>
