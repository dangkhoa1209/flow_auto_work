<script setup lang="ts">
import { onMounted, ref } from "vue";
import { message } from "ant-design-vue";
import { api } from "@/api/client";
import { useSessionStore } from "@/stores/session";

const session = useSessionStore();
const loading = ref(false);
const cursorKey = ref("");
const model = ref(session.me?.cursorModel || "auto");
const models = ref<Array<{ value: string; label: string }>>([
  { value: "auto", label: "Auto (server picks)" },
]);

onMounted(async () => {
  model.value = session.me?.cursorModel || "auto";
  try {
    const data = await api<{
      models?: Array<{ id: string; displayName?: string }>;
      selected?: string;
    }>("/api/me/cursor-models");
    if (data.models?.length) {
      models.value = [
        { value: "auto", label: "Auto (server picks)" },
        ...data.models.map((m) => ({
          value: m.id,
          label: m.displayName || m.id,
        })),
      ];
    }
    if (data.selected) model.value = data.selected;
  } catch {
    /* keep defaults */
  }
});

async function saveModel() {
  loading.value = true;
  try {
    await api("/api/me/preferences", {
      method: "PUT",
      body: JSON.stringify({ cursorModel: model.value }),
    });
    await session.refreshMe();
    message.success("Model saved");
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  } finally {
    loading.value = false;
  }
}

async function saveKey() {
  if (!cursorKey.value.trim()) {
    message.warning("Paste Cursor API key");
    return;
  }
  loading.value = true;
  try {
    await api("/api/me/secrets", {
      method: "PUT",
      body: JSON.stringify({ cursorApiKey: cursorKey.value.trim() }),
    });
    cursorKey.value = "";
    await session.refreshMe();
    message.success("Key saved (encrypted)");
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  } finally {
    loading.value = false;
  }
}

async function clearKey() {
  loading.value = true;
  try {
    await api("/api/me/cursor-key", { method: "DELETE" });
    await session.refreshMe();
    message.success("Key removed");
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="space-y-4">
    <h2 class="text-lg font-medium m-0">Cursor</h2>
    <a-alert
      type="info"
      show-icon
      :message="
        session.me?.hasCursorApiKey
          ? `Key encrypted · model: ${session.me?.cursorModel || 'auto'}`
          : 'No Cursor API key — required before Run'
      "
    />
    <a-form layout="vertical">
      <a-form-item label="Agent model">
        <a-select v-model:value="model" :options="models" class="w-full" />
      </a-form-item>
      <a-button :loading="loading" @click="saveModel">Save model</a-button>

      <a-form-item label="New key" class="mt-4">
        <a-input-password
          v-model:value="cursorKey"
          placeholder="Paste key from cursor.com…"
          autocomplete="off"
        />
        <div class="text-xs text-ink-faint mt-1">
          <a
            href="https://cursor.com/dashboard?tab=integrations"
            target="_blank"
            rel="noopener"
            class="text-accent font-medium"
            >Cursor Dashboard → Integrations</a
          >
        </div>
      </a-form-item>
      <div class="flex gap-2">
        <a-button type="primary" :loading="loading" @click="saveKey"
          >Save key</a-button
        >
        <a-button danger :loading="loading" @click="clearKey">Remove key</a-button>
      </div>
    </a-form>
  </div>
</template>
