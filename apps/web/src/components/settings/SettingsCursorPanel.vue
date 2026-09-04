<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { message, Modal } from "ant-design-vue";
import { MoreOutlined } from "@ant-design/icons-vue";
import { api } from "@/api/client";
import { API } from "@/api/endpoints";
import CursorModelFields from "@/components/settings/CursorModelFields.vue";
import type { CursorPatPublic } from "@/stores/session";
import { useSessionStore } from "@/stores/session";

const session = useSessionStore();
const loading = ref(false);
const modelFieldsRef = ref<InstanceType<typeof CursorModelFields> | null>(null);

const patModalOpen = ref(false);
const patModalMode = ref<"create" | "edit">("create");
const editingPatId = ref<string | null>(null);
const patLabel = ref("");
const patKey = ref("");
const patSaving = ref(false);

const pats = computed(() => session.me?.cursorPats ?? []);
const hasKey = computed(() => Boolean(session.me?.hasCursorApiKey));

const columns = [
  { title: "Active", key: "active", width: 72, align: "center" as const },
  { title: "Label", key: "label", width: 220 },
  { title: "Updated", key: "updatedAt", width: 120 },
  {
    title: "",
    key: "actions",
    width: 52,
    align: "right" as const,
    fixed: "right" as const,
  },
];

const statusLabel = computed(() => {
  if (!pats.value.length) return "Chưa có API key";
  const active = pats.value.find((p) => p.isActive);
  if (!active) return "Chưa chọn key active";
  return `Active: ${active.label}`;
});

async function refreshMe(user?: Record<string, unknown>) {
  if (user) {
    session.me = { ...session.me, ...user };
  } else {
    await session.refreshMe();
  }
}

async function loadModelsForPat(patId?: string | null) {
  await modelFieldsRef.value?.loadModelsForPat(
    patId,
    session.me?.cursorModel || "auto",
  );
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

async function saveModel(storedValue: string) {
  loading.value = true;
  try {
    await api(API.me.preferences, {
      method: "PUT",
      body: JSON.stringify({ cursorModel: storedValue }),
    });
    await session.refreshMe();
    message.success("Đã lưu model");
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  } finally {
    loading.value = false;
  }
}

async function submitPatModal() {
  if (patModalMode.value === "create" && !patKey.value.trim()) {
    message.warning("Dán API key từ Cursor");
    return;
  }

  patSaving.value = true;
  try {
    if (patModalMode.value === "create") {
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
      patModalOpen.value = false;
      message.success("Đã thêm API key");
      const created = (
        res.user?.cursorPats as CursorPatPublic[] | undefined
      )?.at(-1);
      await loadModelsForPat(
        created?.id ||
          session.me?.activeCursorPatId ||
          pats.value.find((p) => p.isActive)?.id ||
          null,
      );
      return;
    }

    if (!editingPatId.value) return;
    const body: { label?: string; apiKey?: string } = {};
    if (patLabel.value.trim()) body.label = patLabel.value.trim();
    if (patKey.value.trim()) body.apiKey = patKey.value.trim();
    if (!body.label && !body.apiKey) {
      message.warning("Đổi tên hoặc dán key mới");
      return;
    }
    const res = await api<{ user?: Record<string, unknown> }>(
      API.me.cursorPat(editingPatId.value),
      { method: "PUT", body: JSON.stringify(body) },
    );
    await refreshMe(res.user);
    patModalOpen.value = false;
    message.success("Đã cập nhật API key");
    await loadModelsForPat(editingPatId.value ?? session.me?.activeCursorPatId);
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
    const res = await api<{ user?: Record<string, unknown> }>(
      API.me.cursorPatActive(patId),
      { method: "PUT", body: JSON.stringify({}) },
    );
    await refreshMe(res.user);
    message.success("Đã chọn key active — Run task sẽ dùng key này");
    await loadModelsForPat(patId);
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  } finally {
    loading.value = false;
  }
}

function confirmDelete(pat: CursorPatPublic) {
  Modal.confirm({
    title: "Xóa API key này?",
    content: pat.isActive
      ? "Đây là key đang active. Key khác sẽ được chọn active nếu còn."
      : "Run task sẽ không còn dùng được key này.",
    okType: "danger",
    okText: "Xóa",
    cancelText: "Hủy",
    onOk: () => deletePat(pat.id),
  });
}

async function deletePat(patId: string) {
  loading.value = true;
  try {
    const res = await api<{ user?: Record<string, unknown> }>(
      API.me.cursorPat(patId),
      { method: "DELETE" },
    );
    await refreshMe(res.user);
    message.success("Đã xóa API key");
    await loadModelsForPat(
      session.me?.activeCursorPatId ||
        pats.value.find((p) => p.isActive)?.id ||
        pats.value[0]?.id ||
        null,
    );
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  } finally {
    loading.value = false;
  }
}

function onPatAction(key: string, pat: CursorPatPublic) {
  if (key === "active") void setActiveById(pat.id);
  else if (key === "edit") openEditModal(pat);
  else if (key === "delete") confirmDelete(pat);
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "—";
  return d.toLocaleDateString("vi-VN", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

onMounted(async () => {
  await session.refreshMe();
  const activeId =
    session.me?.activeCursorPatId ||
    pats.value.find((p) => p.isActive)?.id ||
    pats.value[0]?.id ||
    null;
  await loadModelsForPat(activeId);
});
</script>

<template>
  <div class="faw-settings-detail faw-ai-engine-provider">
    <h2>Cursor</h2>
    <p class="faw-settings-detail__lead m-0 mb-4">
      Quản lý nhiều API key; chỉ một key
      <strong>active</strong> được dùng khi Run task.
    </p>

    <div class="p-4 rounded-lg border border-line bg-surface-raised space-y-4 mb-4">
      <CursorModelFields
        ref="modelFieldsRef"
        :models-url="API.me.cursorModels"
        :loading="loading"
        save-label="Lưu model"
        @save="saveModel"
      />
    </div>

    <a-alert
      :type="hasKey ? 'success' : 'warning'"
      show-icon
      class="mb-4"
      :message="statusLabel"
      :description="
        hasKey
          ? 'Run task dùng key đang active.'
          : 'Thêm API key từ Cursor Dashboard để Run.'
      "
    />

    <div class="flex flex-wrap items-center justify-between gap-2 mb-3">
      <span class="text-sm text-ink-muted">
        {{ pats.length }} key{{ pats.length === 1 ? "" : "s" }}
      </span>
      <a-button type="primary" size="small" @click="openCreateModal">
        + Thêm key
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
      :row-class-name="
        (record: CursorPatPublic) =>
          record.isActive ? 'faw-admin-cursor-table__row--active' : ''
      "
    >
      <template #emptyText>
        <div class="faw-admin-empty py-8">
          <p class="mb-3">Chưa có API key.</p>
          <a-button type="primary" size="small" @click="openCreateModal">
            + Thêm key
          </a-button>
        </div>
      </template>

      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'active'">
          <a-radio
            :checked="(record as CursorPatPublic).isActive"
            :disabled="loading"
            :aria-label="`Đặt ${(record as CursorPatPublic).label} active`"
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
            <div class="text-xs text-ink-muted mt-0.5">Mọi project</div>
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
                @click="
                  (info: { key: string | number }) =>
                    onPatAction(
                      String(info.key),
                      record as CursorPatPublic,
                    )
                "
              >
                <a-menu-item
                  key="active"
                  :disabled="(record as CursorPatPublic).isActive"
                >
                  Set active
                </a-menu-item>
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
      :title="patModalMode === 'create' ? 'Thêm API key' : 'Sửa API key'"
      :confirm-loading="patSaving"
      :ok-text="patModalMode === 'create' ? 'Thêm key' : 'Lưu'"
      cancel-text="Hủy"
      @ok="submitPatModal"
    >
      <div class="space-y-3 py-2">
        <label class="flex flex-col gap-1 text-sm">
          <span class="text-ink-muted">Label</span>
          <a-input
            v-model:value="patLabel"
            placeholder="VD: Cá nhân, Team A…"
          />
        </label>
        <label class="flex flex-col gap-1 text-sm">
          <span class="text-ink-muted">
            {{
              patModalMode === "create"
                ? "API key"
                : "API key mới (tuỳ chọn)"
            }}
          </span>
          <a-input-password
            v-model:value="patKey"
            :placeholder="
              patModalMode === 'create'
                ? 'Dán key từ cursor.com…'
                : 'Để trống nếu không đổi key'
            "
            autocomplete="new-password"
          />
          <span class="text-xs text-ink-faint">
            <a
              href="https://cursor.com/dashboard?tab=integrations"
              target="_blank"
              rel="noopener"
              class="text-accent font-medium"
              >Cursor Dashboard → Integrations</a
            >
          </span>
        </label>
      </div>
    </a-modal>
  </div>
</template>
