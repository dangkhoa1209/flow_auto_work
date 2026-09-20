<script setup lang="ts">
import { onMounted, ref, watch } from "vue";
import { message, Modal } from "ant-design-vue";
import { PlusOutlined } from "@ant-design/icons-vue";
import { useBaChatStore } from "@/stores/baChat";
import { baApi, type BaTaskDraft } from "@/api/baApi";
import BaTaskFormModal from "@/components/ba/BaTaskFormModal.vue";
import { useBaGitPat } from "@/composables/useBaGitPat";

const ba = useBaChatStore();
const { requireGitPat, handleBaPatApiError } = useBaGitPat();
const drafts = ref<BaTaskDraft[]>([]);
const loading = ref(false);
const filter = ref<"" | "draft" | "published">("");

const taskModalOpen = ref(false);
const taskModalLoading = ref(false);
const taskModalPublishLoading = ref(false);
const editingDraftId = ref<string | null>(null);
const taskModalInitial = ref<{
  title?: string;
  description?: string;
  labels?: string[];
  acceptanceCriteria?: string[];
  devNotes?: string;
  includeDevNotes?: boolean;
  milestone?: string;
  gitlabIid?: number | null;
  gitlabUrl?: string | null;
}>({});

async function loadDrafts() {
  if (!ba.selectedProjectId) {
    drafts.value = [];
    return;
  }
  const res = await baApi.listTaskDrafts({
    baProjectId: ba.selectedProjectId,
    status: filter.value || undefined,
  });
  drafts.value = res.taskDrafts || [];
}

async function refresh() {
  loading.value = true;
  try {
    await loadDrafts();
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  } finally {
    loading.value = false;
  }
}

function openNew() {
  editingDraftId.value = null;
  taskModalInitial.value = {};
  taskModalOpen.value = true;
}

function openEdit(d: BaTaskDraft) {
  editingDraftId.value = d.id;
  taskModalInitial.value = {
    title: d.title,
    description: d.description,
    labels: d.labels,
    acceptanceCriteria: d.acceptanceCriteria,
    devNotes: d.devNotes || undefined,
    includeDevNotes: Boolean(d.includeDevNotes),
    milestone: d.milestone || undefined,
    gitlabIid: d.gitlabIid ?? null,
    gitlabUrl: d.gitlabUrl ?? null,
  };
  taskModalOpen.value = true;
}

async function onSave(payload: {
  title: string;
  description: string;
  labels: string[];
  acceptanceCriteria: string[];
  devNotes?: string;
  includeDevNotes: boolean;
  milestone?: string;
}) {
  if (!ba.selectedProjectId) return;
  taskModalLoading.value = true;
  try {
    if (editingDraftId.value) {
      await baApi.updateTaskDraft(editingDraftId.value, {
        title: payload.title,
        description: payload.description,
        labels: payload.labels,
        acceptanceCriteria: payload.acceptanceCriteria,
        devNotes: payload.devNotes ?? null,
        includeDevNotes: payload.includeDevNotes,
        milestone: payload.milestone ?? null,
      });
    } else {
      await baApi.createTaskDraft({
        baProjectId: ba.selectedProjectId,
        ...payload,
      });
    }
    taskModalOpen.value = false;
    message.success("Đã lưu draft");
    await loadDrafts();
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  } finally {
    taskModalLoading.value = false;
  }
}

async function doTaskPublish(payload: {
  title: string;
  description: string;
  labels: string[];
  acceptanceCriteria: string[];
  devNotes?: string;
  includeDevNotes: boolean;
  milestone: string;
  assignee?: string;
  mode?: "update" | "new";
}) {
  if (!ba.selectedProjectId) return;
  taskModalPublishLoading.value = true;
  try {
    let draftId = editingDraftId.value;
    if (draftId) {
      await baApi.updateTaskDraft(draftId, {
        title: payload.title,
        description: payload.description,
        labels: payload.labels,
        acceptanceCriteria: payload.acceptanceCriteria,
        devNotes: payload.devNotes ?? null,
        includeDevNotes: payload.includeDevNotes,
        milestone: payload.milestone,
      });
    } else {
      const created = await baApi.createTaskDraft({
        baProjectId: ba.selectedProjectId,
        title: payload.title,
        description: payload.description,
        labels: payload.labels,
        acceptanceCriteria: payload.acceptanceCriteria,
        devNotes: payload.devNotes,
        includeDevNotes: payload.includeDevNotes,
        milestone: payload.milestone,
      });
      draftId = created.taskDraft.id;
    }
    const pub = await baApi.publishTaskDraft(draftId, {
      assignee: payload.assignee,
      milestone: payload.milestone,
      mode: payload.mode,
      includeDevNotes: payload.includeDevNotes,
    });
    taskModalOpen.value = false;
    message.success(
      pub.mode === "update"
        ? `Đã cập nhật task GitLab #${pub.issue.iid}`
        : `Đã lên GitLab #${pub.issue.iid}`,
    );
    await loadDrafts();
  } catch (e) {
    if (!handleBaPatApiError(e, () => void doTaskPublish(payload))) {
      message.error(e instanceof Error ? e.message : String(e));
    }
  } finally {
    taskModalPublishLoading.value = false;
  }
}

function onPublish(payload: {
  title: string;
  description: string;
  labels: string[];
  acceptanceCriteria: string[];
  devNotes?: string;
  includeDevNotes: boolean;
  milestone: string;
  assignee?: string;
  mode?: "update" | "new";
}) {
  if (!requireGitPat(() => void doTaskPublish(payload))) return;
  void doTaskPublish(payload);
}

function onPublishOne(d: BaTaskDraft) {
  openEdit(d);
}

function onDelete(id: string, title: string) {
  Modal.confirm({
    title: "Xóa draft?",
    content: title,
    okType: "danger",
    okText: "Xóa",
    onOk: async () => {
      await baApi.deleteTaskDraft(id);
      drafts.value = drafts.value.filter((d) => d.id !== id);
    },
  });
}

watch(
  () => [ba.selectedProjectId, filter.value],
  () => void refresh(),
);

onMounted(() => void refresh());
</script>

<template>
  <div class="faw-ba-tasks h-full min-h-0 flex flex-col overflow-hidden">
    <div class="faw-console-head shrink-0 flex-wrap gap-2">
      <div class="faw-console-head__title min-w-0">
        <h2>Task drafts</h2>
        <div class="faw-console-head__win">
          {{ ba.selectedProject?.displayName || "Chọn project ở thanh trên cùng" }}
        </div>
      </div>
      <div class="flex items-center gap-2 flex-wrap w-full sm:w-auto">
        <a-segmented
          v-model:value="filter"
          size="small"
          :options="[
            { label: 'Tất cả', value: '' },
            { label: 'Draft', value: 'draft' },
            { label: 'Published', value: 'published' },
          ]"
        />
        <button
          type="button"
          class="faw-btn faw-btn--run"
          :disabled="!ba.projectReady"
          @click="openNew"
        >
          <PlusOutlined /> Lên task
        </button>
      </div>
    </div>

    <div class="flex-1 min-h-0 overflow-y-auto p-4">
      <a-spin :spinning="loading">
        <a-empty v-if="!drafts.length" description="Chưa có task draft" />
        <div v-else class="space-y-2">
          <div
            v-for="d in drafts"
            :key="d.id"
            class="faw-ba-thread flex items-center gap-3 px-3 py-2 rounded border border-[var(--app-border)]"
          >
            <div class="flex-1 min-w-0">
              <div class="font-medium text-[13px] truncate">{{ d.title }}</div>
              <div class="text-[11px] text-[var(--app-muted)]">
                {{ d.status }}
                <template v-if="d.requirementId"> · từ YC</template>
                <template v-if="d.threadId"> · từ chat</template>
              </div>
              <a
                v-if="d.gitlabUrl"
                :href="d.gitlabUrl"
                target="_blank"
                rel="noopener"
                class="text-[11px]"
              >
                GitLab #{{ d.gitlabIid }}
              </a>
            </div>
            <div class="flex gap-1 shrink-0">
              <button type="button" class="faw-btn text-[11px]" @click="openEdit(d)">
                Xem
              </button>
              <button
                type="button"
                class="faw-btn faw-btn--run text-[11px]"
                @click="onPublishOne(d)"
              >
                {{ d.status === "published" ? "Cập nhật / tạo mới" : "Lên GitLab" }}
              </button>
              <button
                type="button"
                class="faw-btn faw-btn--danger text-[11px]"
                @click="onDelete(d.id, d.title)"
              >
                Xóa
              </button>
            </div>
          </div>
        </div>
      </a-spin>
    </div>

    <BaTaskFormModal
      v-model:open="taskModalOpen"
      :ba-project-id="ba.selectedProjectId || ''"
      :initial="taskModalInitial"
      :loading="taskModalLoading"
      :publish-loading="taskModalPublishLoading"
      @save="onSave"
      @publish="onPublish"
    />
  </div>
</template>
