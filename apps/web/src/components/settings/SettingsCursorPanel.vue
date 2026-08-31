<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { message } from "ant-design-vue";
import { api } from "@/api/client";
import { API } from "@/api/endpoints";
import { useCursorModelSelect } from "@/composables/useCursorModelSelect";
import type { CursorPatPublic } from "@/stores/session";
import { useSessionStore } from "@/stores/session";

const session = useSessionStore();
const loading = ref(false);
const patLabel = ref("");
const patKey = ref("");
const selectedPatId = ref<string | null>(null);
const creatingNew = ref(false);

const {
  model,
  models,
  modelsLoading,
  modelsWarning,
  loadModels,
} = useCursorModelSelect(API.me.cursorModels);

const pats = computed(() => session.me?.cursorPats ?? []);

const selectedPat = computed(() =>
  pats.value.find((p) => p.id === selectedPatId.value) ?? null,
);

const cursorStatusLabel = computed(() => {
  if (session.me?.hasCursorApiKey && pats.value.length <= 1) {
    return "Key đã lưu";
  }
  if (!pats.value.length) return "Chưa có PAT";
  const active = pats.value.find((p) => p.isActive);
  if (!active) return "Chưa chọn active";
  return `Active: ${active.label}`;
});

const cursorStatusOk = computed(() => Boolean(session.me?.hasCursorApiKey));

const singleKeyMode = computed(() => pats.value.length <= 1);

function syncSelection() {
  const list = pats.value;
  if (!list.length) {
    selectedPatId.value = null;
    creatingNew.value = true;
    patLabel.value = "";
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

function selectPat(pat: CursorPatPublic) {
  creatingNew.value = false;
  selectedPatId.value = pat.id;
  patLabel.value = pat.label;
  patKey.value = "";
  void loadModelsForPat(pat.id);
}

function startNewPat() {
  creatingNew.value = true;
  selectedPatId.value = null;
  patLabel.value = `PAT ${pats.value.length + 1}`;
  patKey.value = "";
}

async function loadModelsForPat(patId?: string | null) {
  const url = patId
    ? `${API.me.cursorModels}?patId=${encodeURIComponent(patId)}`
    : API.me.cursorModels;
  await loadModels(session.me?.cursorModel || "auto", url);
}

onMounted(async () => {
  await session.refreshMe();
  syncSelection();
  const activeId =
    session.me?.activeCursorPatId ||
    pats.value.find((p) => p.isActive)?.id ||
    pats.value[0]?.id ||
    null;
  await loadModelsForPat(activeId);
});

watch(
  () => session.me?.cursorPats,
  () => syncSelection(),
  { deep: true },
);

async function refreshMe(user?: Record<string, unknown>) {
  if (user) {
    session.me = { ...session.me, ...user };
  } else {
    await session.refreshMe();
  }
}

async function saveModel() {
  loading.value = true;
  try {
    await api(API.me.preferences, {
      method: "PUT",
      body: JSON.stringify({ cursorModel: model.value }),
    });
    await session.refreshMe();
    message.success("Đã lưu model");
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  } finally {
    loading.value = false;
  }
}

async function savePat() {
  if (!patKey.value.trim() && creatingNew.value) {
    message.warning("Dán API key");
    return;
  }
  loading.value = true;
  try {
    if (creatingNew.value && singleKeyMode.value) {
      const res = await api<{ user?: Record<string, unknown> }>(
        API.me.secrets,
        {
          method: "PUT",
          body: JSON.stringify({ cursorApiKey: patKey.value.trim() }),
        },
      );
      await refreshMe(res.user);
      creatingNew.value = false;
      syncSelection();
      patKey.value = "";
      message.success("Đã lưu key");
      await loadModelsForPat(session.me?.activeCursorPatId);
      return;
    }

    if (creatingNew.value) {
      const res = await api<{ user?: Record<string, unknown> }>(
        API.me.cursorPats,
        {
          method: "POST",
          body: JSON.stringify({
            label: patLabel.value.trim() || undefined,
            apiKey: patKey.value.trim(),
          }),
        },
      );
      await refreshMe(res.user);
      creatingNew.value = false;
      const created = (res.user?.cursorPats as CursorPatPublic[] | undefined)?.at(
        -1,
      );
      if (created) selectedPatId.value = created.id;
      patKey.value = "";
      message.success("Đã lưu key");
      await loadModelsForPat(session.me?.activeCursorPatId);
      return;
    }

    // Single-key compat: PUT /secrets replaces the active key like before.
    if (singleKeyMode.value && patKey.value.trim()) {
      const res = await api<{ user?: Record<string, unknown> }>(
        API.me.secrets,
        {
          method: "PUT",
          body: JSON.stringify({ cursorApiKey: patKey.value.trim() }),
        },
      );
      await refreshMe(res.user);
      patKey.value = "";
      message.success("Đã lưu key");
      await loadModelsForPat(session.me?.activeCursorPatId);
      return;
    }

    if (selectedPatId.value) {
      const body: { label?: string; apiKey?: string } = {};
      if (patLabel.value.trim()) body.label = patLabel.value.trim();
      if (patKey.value.trim()) body.apiKey = patKey.value.trim();
      if (!body.label && !body.apiKey) {
        message.warning("Đổi tên hoặc dán key mới");
        return;
      }
      const res = await api<{ user?: Record<string, unknown> }>(
        API.me.cursorPat(selectedPatId.value),
        { method: "PUT", body: JSON.stringify(body) },
      );
      await refreshMe(res.user);
      patKey.value = "";
      message.success("Đã lưu PAT");
      await loadModelsForPat(selectedPatId.value);
    }
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
    const res = await api<{ user?: Record<string, unknown> }>(
      API.me.cursorPatActive(selectedPatId.value),
      { method: "PUT", body: JSON.stringify({}) },
    );
    await refreshMe(res.user);
    message.success("Đã chọn PAT active");
    await loadModelsForPat(selectedPatId.value);
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  } finally {
    loading.value = false;
  }
}

async function deletePat() {
  loading.value = true;
  try {
    if (singleKeyMode.value || !selectedPatId.value) {
      const res = await api<{ user?: Record<string, unknown> }>(
        API.me.cursorKey,
        { method: "DELETE" },
      );
      await refreshMe(res.user);
      creatingNew.value = true;
      syncSelection();
      patKey.value = "";
      message.success("Đã xóa key");
      await loadModelsForPat(null);
      return;
    }
    const res = await api<{ user?: Record<string, unknown> }>(
      API.me.cursorPat(selectedPatId.value),
      { method: "DELETE" },
    );
    await refreshMe(res.user);
    creatingNew.value = false;
    syncSelection();
    message.success("Đã xóa PAT");
    await loadModelsForPat(session.me?.activeCursorPatId);
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="faw-settings-detail faw-ai-engine-provider">
    <h2>Cursor</h2>

    <a-form layout="vertical" class="faw-ai-engine-provider__model">
      <a-form-item label="Agent model (mặc định)">
        <a-select
          v-model:value="model"
          :options="models"
          :loading="modelsLoading"
          class="w-full"
        />
      </a-form-item>
      <a-alert
        v-if="modelsWarning"
        type="warning"
        show-icon
        class="mb-3"
        :message="modelsWarning"
      />
      <a-button :loading="loading" @click="saveModel">Lưu model</a-button>
    </a-form>

    <div class="faw-integrations__shell faw-ai-engine-provider__pats">
      <aside class="faw-integrations__list" aria-label="Danh sách PAT">
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
          <span class="faw-integrations__item-hint">API key · mọi project</span>
        </button>
        <button
          type="button"
          class="faw-integrations__item faw-ai-engine-provider__add"
          :class="{ 'is-active': creatingNew }"
          @click="startNewPat"
        >
          <span class="faw-integrations__item-label">+ Thêm PAT</span>
        </button>
      </aside>

      <div class="faw-integrations__detail">
        <a-alert
          :type="cursorStatusOk ? 'success' : 'warning'"
          show-icon
          class="mb-4"
          :message="cursorStatusLabel"
          :description="
            cursorStatusOk
              ? singleKeyMode
                ? 'Run task dùng key này — giống cấu hình một key trước đây.'
                : 'Run task dùng PAT đang active.'
              : 'Dán API key từ Cursor Dashboard để Run.'
          "
        />

        <a-form layout="vertical">
          <a-form-item
            v-if="!singleKeyMode || pats.length > 1 || creatingNew"
            label="Tên PAT"
          >
            <a-input
              v-model:value="patLabel"
              placeholder="VD: Cá nhân, Team A…"
            />
          </a-form-item>
          <a-form-item
            :label="
              creatingNew || !session.me?.hasCursorApiKey
                ? 'API key'
                : 'API key mới (tuỳ chọn)'
            "
          >
            <a-input-password
              v-model:value="patKey"
              :placeholder="
                creatingNew
                  ? 'Dán key từ cursor.com…'
                  : 'Để trống nếu không đổi key'
              "
              autocomplete="new-password"
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
          <div class="flex flex-wrap gap-2">
            <a-button type="primary" :loading="loading" @click="savePat">
              {{
                creatingNew
                  ? singleKeyMode
                    ? "Lưu key"
                    : "Thêm PAT"
                  : singleKeyMode
                    ? "Lưu key"
                    : "Lưu PAT"
              }}
            </a-button>
            <a-button
              v-if="!singleKeyMode && selectedPat && !selectedPat.isActive"
              :loading="loading"
              @click="setActive"
            >
              Đặt active
            </a-button>
            <a-button
              v-if="cursorStatusOk || selectedPat"
              danger
              :loading="loading"
              @click="deletePat"
            >
              {{ singleKeyMode ? "Xóa key" : "Xóa PAT" }}
            </a-button>
          </div>
        </a-form>
      </div>
    </div>
  </div>
</template>
