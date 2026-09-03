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

type CursorSettings = {
  hasCursorApiKey?: boolean;
  cursorPats?: CursorPatPublic[];
  activeCursorPatId?: string | null;
  cursorModel?: string;
};

const columns = [
  { title: "Active", key: "active", width: 72, align: "center" as const },
  { title: "Label", key: "label", width: 220 },
  { title: "Updated", key: "updatedAt", width: 120 },
  { title: "", key: "actions", width: 52, align: "right" as const, fixed: "right" as const },
];

const loading = ref(false);
const pats = ref<CursorPatPublic[]>([]);
const hasKey = ref(false);

const patModalOpen = ref(false);
const patModalMode = ref<"create" | "edit">("create");
const editingPatId = ref<string | null>(null);
const patLabel = ref("");
const patKey = ref("");
const patSaving = ref(false);

const {
  model,
  models,
  modelsLoading,
  modelsWarning,
  loadModels,
} = useCursorModelSelect(API.admin.cursorModels);

const statusLabel = computed(() => {
  if (!pats.value.length) return "No API key yet";
  const active = pats.value.find((p) => p.isActive);
  if (!active) return "No active key selected";
  return `Active: ${active.label}`;
});

function applySettings(data: CursorSettings) {
  hasKey.value = Boolean(data.hasCursorApiKey);
  pats.value = data.cursorPats || [];
}

async function load() {
  loading.value = true;
  try {
    const data = await api<CursorSettings>(API.admin.cursorSettings);
    applySettings(data);
    await loadModelsForPat(
      data.activeCursorPatId ||
        data.cursorPats?.find((p) => p.isActive)?.id ||
        data.cursorPats?.[0]?.id ||
        null,
      data.cursorModel || "auto",
    );
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  } finally {
    loading.value = false;
  }
}

async function loadModelsForPat(
  patId?: string | null,
  selectedFallback?: string | null,
) {
  const url = patId
    ? `${API.admin.cursorModels}?patId=${encodeURIComponent(patId)}`
    : API.admin.cursorModels;
  await loadModels(selectedFallback ?? model.value, url);
}

function openCreateModal() {
  patModalMode.value = "create";
  editingPatId.value = null;
  patLabel.value = `PAT ${pats.value.length + 1}`;
  patKey.value = "";
  patModalOpen.value = true;
}

function openEditModal(pat: CursorPatPublic) {
  patModalMode.value = "edit";
  editingPatId.value = pat.id;
  patLabel.value = pat.label;
  patKey.value = "";
  patModalOpen.value = true;
}

async function saveModel() {
  loading.value = true;
  try {
    const data = await api<CursorSettings>(API.admin.cursorSettings, {
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

async function submitPatModal() {
  if (patModalMode.value === "create" && !patKey.value.trim()) {
    message.warning("Paste a Cursor API key");
    return;
  }

  patSaving.value = true;
  try {
    if (patModalMode.value === "create") {
      const data = await api<CursorSettings>(API.admin.cursorPats, {
        method: "POST",
        body: JSON.stringify({
          label: patLabel.value.trim() || undefined,
          apiKey: patKey.value.trim(),
        }),
      });
      applySettings(data);
      patModalOpen.value = false;
      message.success("API key added");
      await loadModelsForPat(
        data.activeCursorPatId ||
          data.cursorPats?.find((p) => p.isActive)?.id ||
          data.cursorPats?.at(-1)?.id ||
          null,
      );
      return;
    }

    if (!editingPatId.value) return;
    const body: { label?: string; apiKey?: string } = {};
    if (patLabel.value.trim()) body.label = patLabel.value.trim();
    if (patKey.value.trim()) body.apiKey = patKey.value.trim();
    if (!body.label && !body.apiKey) {
      message.warning("Change the label or paste a new key");
      return;
    }
    const data = await api<CursorSettings>(
      API.admin.cursorPat(editingPatId.value),
      {
        method: "PUT",
        body: JSON.stringify(body),
      },
    );
    applySettings(data);
    patModalOpen.value = false;
    message.success("API key updated");
    await loadModelsForPat(editingPatId.value ?? data.activeCursorPatId);
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  } finally {
    patSaving.value = false;
  }
}

async function setActiveById(patId: string) {
  const pat = pats.value.find((p) => p.id === patId);
  if (!pat || pat.isActive || loading.value) return;
  loading.value = true;
  try {
    const data = await api<CursorSettings>(API.admin.cursorPatActive(patId), {
      method: "PUT",
      body: JSON.stringify({}),
    });
    applySettings(data);
    message.success("Active key updated — BA Chat will use this key");
    await loadModelsForPat(patId ?? data.activeCursorPatId);
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  } finally {
    loading.value = false;
  }
}

function confirmDelete(pat: CursorPatPublic) {
  Modal.confirm({
    title: "Delete this API key?",
    content: pat.isActive
      ? "This is the active key. Another key will become active if available."
      : "BA Chat will no longer be able to use this key.",
    okType: "danger",
    okText: "Delete",
    cancelText: "Cancel",
    onOk: () => deletePat(pat.id),
  });
}

async function deletePat(patId: string) {
  loading.value = true;
  try {
    const data = await api<CursorSettings>(API.admin.cursorPat(patId), {
      method: "DELETE",
    });
    applySettings(data);
    message.success("API key deleted");
    await loadModelsForPat(
      data.activeCursorPatId ||
        data.cursorPats?.find((p) => p.isActive)?.id ||
        data.cursorPats?.[0]?.id ||
        null,
      data.cursorModel || "auto",
    );
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  } finally {
    loading.value = false;
  }
}

function onPatAction(key: string, pat: CursorPatPublic) {
  if (key === "edit") openEditModal(pat);
  else if (key === "delete") confirmDelete(pat);
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
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

    <div class="flex flex-wrap items-center justify-between gap-2 mb-3">
      <span class="text-sm text-ink-muted">
        {{ pats.length }} key{{ pats.length === 1 ? '' : 's' }}
      </span>
      <a-button type="primary" size="small" @click="openCreateModal">
        + Add key
      </a-button>
    </div>

    <a-table
      class="faw-admin-cursor-table"
      size="small"
      row-key="id"
      :columns="columns"
      :data-source="pats"
      :loading="loading"
      :scroll="{ x: 520 }"
      :pagination="false"
      :row-class-name="(record: CursorPatPublic) => (record.isActive ? 'faw-admin-cursor-table__row--active' : '')"
    >
      <template #emptyText>
        <div class="faw-admin-empty py-8">
          <p class="mb-3">No API keys yet.</p>
          <a-button type="primary" size="small" @click="openCreateModal">
            + Add key
          </a-button>
        </div>
      </template>

      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'active'">
          <a-radio
            :checked="(record as CursorPatPublic).isActive"
            :disabled="loading"
            :aria-label="`Set ${(record as CursorPatPublic).label} active`"
            @change="setActiveById((record as CursorPatPublic).id)"
          />
        </template>

        <template v-else-if="column.key === 'label'">
          <div class="min-w-0">
            <span class="font-semibold text-ink">
              {{ (record as CursorPatPublic).label }}
            </span>
            <a-tag
              v-if="(record as CursorPatPublic).isActive"
              class="!m-0 !ml-1.5 align-middle"
              color="green"
            >
              Active
            </a-tag>
            <div class="text-xs text-ink-muted mt-0.5">Shared · BA Chat</div>
          </div>
        </template>

        <template v-else-if="column.key === 'updatedAt'">
          <span class="font-mono text-xs text-ink-muted">
            {{ formatDate((record as CursorPatPublic).updatedAt) }}
          </span>
        </template>

        <template v-else-if="column.key === 'actions'">
          <a-dropdown :trigger="['click']">
            <a-button size="small" type="text" class="!px-1.5">
              <MoreOutlined />
            </a-button>
            <template #overlay>
              <a-menu
                @click="(info: { key: string | number }) => onPatAction(String(info.key), record as CursorPatPublic)"
              >
                <a-menu-item key="edit">Edit</a-menu-item>
                <a-menu-divider />
                <a-menu-item key="delete" danger>Delete</a-menu-item>
              </a-menu>
            </template>
          </a-dropdown>
        </template>
      </template>
    </a-table>

    <a-modal
      v-model:open="patModalOpen"
      :title="patModalMode === 'create' ? 'Add API key' : 'Edit API key'"
      :confirm-loading="patSaving"
      :ok-text="patModalMode === 'create' ? 'Add key' : 'Save'"
      cancel-text="Cancel"
      @ok="submitPatModal"
    >
      <div class="space-y-3 py-2">
        <label class="flex flex-col gap-1 text-sm">
          <span class="text-ink-muted">Label</span>
          <a-input
            v-model:value="patLabel"
            placeholder="e.g. Team A, Backup…"
          />
        </label>
        <label class="flex flex-col gap-1 text-sm">
          <span class="text-ink-muted">
            {{ patModalMode === 'create' ? 'API key' : 'New API key (optional)' }}
          </span>
          <a-input-password
            v-model:value="patKey"
            :placeholder="
              patModalMode === 'create'
                ? 'Paste key from cursor.com…'
                : 'Leave blank to keep current key'
            "
            autocomplete="new-password"
          />
          <span class="text-xs text-ink-faint">
            <a
              href="https://cursor.com/dashboard?tab=integrations"
              target="_blank"
              rel="noopener"
              class="text-accent font-medium"
            >Cursor Dashboard → Integrations</a>
          </span>
        </label>
      </div>
    </a-modal>
  </div>
</template>
