<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { message, Modal } from "ant-design-vue";
import { MoreOutlined } from "@ant-design/icons-vue";
import { api } from "@/api/client";
import { API } from "@/api/endpoints";
import { useCursorModelSelect } from "@/composables/useCursorModelSelect";

type CursorPatPublic = {
  id: string;
  label: string;
  createdAt: string;
  updatedAt: string;
  isActive: boolean;
};

const loading = ref(false);
const pats = ref<CursorPatPublic[]>([]);
const activeCursorPatId = ref<string | null>(null);
const hasKey = ref(false);

const creatingNew = ref(false);
const selectedPatId = ref<string | null>(null);
const patLabel = ref("");
const patKey = ref("");

const {
  model,
  models,
  modelsLoading,
  modelsWarning,
  loadModels,
} = useCursorModelSelect(API.admin.cursorModels);

const selectedPat = computed(
  () => pats.value.find((p) => p.id === selectedPatId.value) ?? null,
);

const statusLabel = computed(() => {
  if (!pats.value.length) return "No API key yet";
  const active = pats.value.find((p) => p.isActive);
  if (!active) return "No active key selected";
  return `Active: ${active.label}`;
});

function syncSelection() {
  const list = pats.value;
  if (!list.length) {
    selectedPatId.value = null;
    creatingNew.value = true;
    patLabel.value = "PAT 1";
    patKey.value = "";
    return;
  }
  if (creatingNew.value) return;
  const active = list.find((p) => p.isActive);
  const current = list.find((p) => p.id === selectedPatId.value);
  selectedPatId.value = current?.id ?? active?.id ?? list[0]?.id ?? null;
  if (selectedPat.value) {
    patLabel.value = selectedPat.value.label;
    patKey.value = "";
  }
}

function applySettings(data: {
  hasCursorApiKey?: boolean;
  cursorPats?: CursorPatPublic[];
  activeCursorPatId?: string | null;
  cursorModel?: string;
}) {
  hasKey.value = Boolean(data.hasCursorApiKey);
  pats.value = data.cursorPats || [];
  activeCursorPatId.value = data.activeCursorPatId ?? null;
  syncSelection();
}

async function load() {
  loading.value = true;
  try {
    const data = await api<{
      hasCursorApiKey?: boolean;
      cursorPats?: CursorPatPublic[];
      activeCursorPatId?: string | null;
      cursorModel?: string;
    }>(API.admin.cursorSettings);
    applySettings(data);
    await loadModels(data.cursorModel || "auto");
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  } finally {
    loading.value = false;
  }
}

function selectPat(pat: CursorPatPublic) {
  creatingNew.value = false;
  selectedPatId.value = pat.id;
  patLabel.value = pat.label;
  patKey.value = "";
}

function startNewPat() {
  creatingNew.value = true;
  selectedPatId.value = null;
  patLabel.value = `PAT ${pats.value.length + 1}`;
  patKey.value = "";
}

async function saveModel() {
  loading.value = true;
  try {
    const data = await api<{
      hasCursorApiKey?: boolean;
      cursorPats?: CursorPatPublic[];
      activeCursorPatId?: string | null;
      cursorModel?: string;
    }>(API.admin.cursorSettings, {
      method: "PUT",
      body: JSON.stringify({ cursorModel: model.value }),
    });
    applySettings(data);
    message.success("Model saved");
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  } finally {
    loading.value = false;
  }
}

async function savePat() {
  if (creatingNew.value && !patKey.value.trim()) {
    message.warning("Paste a Cursor API key");
    return;
  }
  loading.value = true;
  try {
    if (creatingNew.value) {
      const data = await api<{
        hasCursorApiKey?: boolean;
        cursorPats?: CursorPatPublic[];
        activeCursorPatId?: string | null;
        cursorModel?: string;
      }>(API.admin.cursorPats, {
        method: "POST",
        body: JSON.stringify({
          label: patLabel.value.trim() || undefined,
          apiKey: patKey.value.trim(),
        }),
      });
      creatingNew.value = false;
      applySettings(data);
      const created = pats.value.at(-1);
      if (created) selectedPatId.value = created.id;
      patKey.value = "";
      message.success("API key added");
      await loadModels(data.cursorModel || model.value);
      return;
    }

    if (!selectedPatId.value) return;
    const body: { label?: string; apiKey?: string } = {};
    if (patLabel.value.trim()) body.label = patLabel.value.trim();
    if (patKey.value.trim()) body.apiKey = patKey.value.trim();
    if (!body.label && !body.apiKey) {
      message.warning("Change the label or paste a new key");
      return;
    }
    const data = await api<{
      hasCursorApiKey?: boolean;
      cursorPats?: CursorPatPublic[];
      activeCursorPatId?: string | null;
      cursorModel?: string;
    }>(API.admin.cursorPat(selectedPatId.value), {
      method: "PUT",
      body: JSON.stringify(body),
    });
    applySettings(data);
    patKey.value = "";
    message.success("API key updated");
    await loadModels(data.cursorModel || model.value);
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  } finally {
    loading.value = false;
  }
}

async function setActive() {
  if (!selectedPatId.value || selectedPat.value?.isActive) return;
  loading.value = true;
  try {
    const data = await api<{
      hasCursorApiKey?: boolean;
      cursorPats?: CursorPatPublic[];
      activeCursorPatId?: string | null;
      cursorModel?: string;
    }>(API.admin.cursorPatActive(selectedPatId.value), {
      method: "PUT",
      body: JSON.stringify({}),
    });
    applySettings(data);
    message.success("Active key updated — BA Chat will use this key");
    await loadModels(data.cursorModel || model.value);
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  } finally {
    loading.value = false;
  }
}

function confirmDelete() {
  if (!selectedPatId.value && !creatingNew.value) return;
  Modal.confirm({
    title: "Delete this API key?",
    content: selectedPat.value?.isActive
      ? "This is the active key. Another key will become active if available."
      : "BA Chat will no longer be able to use this key.",
    okType: "danger",
    okText: "Delete",
    cancelText: "Cancel",
    onOk: () => deletePat(),
  });
}

async function deletePat() {
  if (!selectedPatId.value) return;
  loading.value = true;
  try {
    const data = await api<{
      hasCursorApiKey?: boolean;
      cursorPats?: CursorPatPublic[];
      activeCursorPatId?: string | null;
      cursorModel?: string;
    }>(API.admin.cursorPat(selectedPatId.value), { method: "DELETE" });
    creatingNew.value = false;
    applySettings(data);
    message.success("API key deleted");
    await loadModels(data.cursorModel || model.value);
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  } finally {
    loading.value = false;
  }
}

function onPatAction(key: string) {
  if (key === "active") void setActive();
  else if (key === "delete") confirmDelete();
}

onMounted(() => {
  void load();
});
</script>

<template>
  <div class="faw-admin-page">
    <header class="faw-admin-page__head">
      <div>
        <h1 class="faw-admin-page__title">AI Engine</h1>
        <p class="faw-admin-page__desc">
          Shared Cursor API keys for BA Chat. Add multiple keys; only one can be
          <strong>active</strong> for the system.
        </p>
      </div>
    </header>

    <div class="p-4 rounded-lg border border-line bg-surface-raised space-y-4 mb-4">
      <label class="flex flex-col gap-1 text-sm">
        <span class="text-ink-muted">Agent model</span>
        <a-select
          v-model:value="model"
          :options="models"
          :loading="modelsLoading"
          class="w-full max-w-md"
        />
      </label>
      <a-alert
        v-if="modelsWarning"
        type="warning"
        show-icon
        :message="modelsWarning"
      />
      <a-button size="small" type="primary" :loading="loading" @click="saveModel">
        Save model
      </a-button>
    </div>

    <div class="faw-integrations__shell">
      <aside class="faw-integrations__list" aria-label="Cursor API keys">
        <button
          v-for="pat in pats"
          :key="pat.id"
          type="button"
          class="faw-integrations__item"
          :class="{ 'is-active': !creatingNew && selectedPatId === pat.id }"
          @click="selectPat(pat)"
        >
          <span class="faw-integrations__item-top">
            <span class="faw-integrations__item-label">{{ pat.label }}</span>
            <span
              class="faw-integrations__item-badge"
              :class="pat.isActive ? 'is-ok' : ''"
            >
              {{ pat.isActive ? "Active" : "—" }}
            </span>
          </span>
          <span class="faw-integrations__item-hint">Shared · BA Chat</span>
        </button>
        <button
          type="button"
          class="faw-integrations__item"
          :class="{ 'is-active': creatingNew }"
          @click="startNewPat"
        >
          <span class="faw-integrations__item-label">+ Add key</span>
        </button>
      </aside>

      <div class="faw-integrations__detail">
        <a-alert
          :type="hasKey ? 'success' : 'warning'"
          show-icon
          class="mb-4"
          :message="statusLabel"
          :description="
            hasKey
              ? 'BA Chat agent runs use the active key only.'
              : 'Add a Cursor API key from the Cursor Dashboard.'
          "
        />

        <a-form layout="vertical">
          <a-form-item label="Label">
            <a-input
              v-model:value="patLabel"
              placeholder="e.g. Team A, Backup…"
            />
          </a-form-item>
          <a-form-item
            :label="creatingNew || !hasKey ? 'API key' : 'New API key (optional)'"
          >
            <a-input-password
              v-model:value="patKey"
              :placeholder="
                creatingNew
                  ? 'Paste key from cursor.com…'
                  : 'Leave blank to keep current key'
              "
              autocomplete="new-password"
            />
            <div class="text-xs text-ink-faint mt-1">
              <a
                href="https://cursor.com/dashboard?tab=integrations"
                target="_blank"
                rel="noopener"
                class="text-accent font-medium"
              >Cursor Dashboard → Integrations</a>
            </div>
          </a-form-item>
          <div class="flex flex-wrap gap-2 items-center">
            <a-button type="primary" size="small" :loading="loading" @click="savePat">
              {{ creatingNew ? "Add key" : "Save" }}
            </a-button>
            <template v-if="!creatingNew && selectedPat">
              <a-dropdown :trigger="['click']">
                <a-button size="small" type="text" class="!px-1.5">
                  <MoreOutlined />
                </a-button>
                <template #overlay>
                  <a-menu @click="(info: { key: string | number }) => onPatAction(String(info.key))">
                    <a-menu-item key="active" :disabled="selectedPat.isActive">
                      Set active
                    </a-menu-item>
                    <a-menu-divider />
                    <a-menu-item key="delete" danger>Delete</a-menu-item>
                  </a-menu>
                </template>
              </a-dropdown>
            </template>
          </div>
        </a-form>
      </div>
    </div>
  </div>
</template>
