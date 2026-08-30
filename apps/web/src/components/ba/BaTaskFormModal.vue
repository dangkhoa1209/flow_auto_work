<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import BaIssueDescriptionEditor from "@/components/ba/BaIssueDescriptionEditor.vue";
import { baApi } from "@/api/baApi";
import { useBaGitPat } from "@/composables/useBaGitPat";

const props = defineProps<{
  open: boolean;
  baProjectId: string;
  loading?: boolean;
  publishLoading?: boolean;
  /** Agent đang soạn draft (SSE) — khóa form + hiện overlay */
  agentDrafting?: boolean;
  agentDraftLabel?: string;
  initial?: {
    title?: string;
    description?: string;
    labels?: string[];
    acceptanceCriteria?: string[];
    devNotes?: string;
    includeDevNotes?: boolean;
    milestone?: string;
    assignee?: string;
    requirementId?: string;
    threadId?: string;
    messageId?: string;
    /** Task đã lên GitLab → hỏi cập nhật hay tạo mới khi publish. */
    gitlabIid?: number | null;
    gitlabUrl?: string | null;
  };
}>();

const emit = defineEmits<{
  "update:open": [boolean];
  save: [
    payload: {
      title: string;
      description: string;
      labels: string[];
      acceptanceCriteria: string[];
      devNotes?: string;
      includeDevNotes: boolean;
      milestone?: string;
      assignee?: string;
      requirementId?: string;
      threadId?: string;
      messageId?: string;
    },
  ];
  publish: [
    payload: {
      title: string;
      description: string;
      labels: string[];
      acceptanceCriteria: string[];
      devNotes?: string;
      includeDevNotes: boolean;
      milestone: string;
      assignee?: string;
      requirementId?: string;
      threadId?: string;
      messageId?: string;
      /** Chỉ khi task đã có trên GitLab. */
      mode?: "update" | "new";
    },
  ];
}>();

const { handleBaPatApiError, openPatModal } = useBaGitPat();

const form = reactive({
  title: "",
  description: "",
  labels: [] as string[],
  devNotes: "",
  includeDevNotes: false,
  assignee: undefined as string | undefined,
  milestone: undefined as string | undefined,
});

/** update = cập nhật issue cũ, new = tạo issue mới (chỉ khi đã publish). */
const publishMode = ref<"update" | "new">("update");
const alreadyPublished = computed(() => Boolean(props.initial?.gitlabIid));

const touched = ref(false);
const editorKey = ref(0);
const metaLoading = ref(false);
const metaError = ref("");
const currentUser = ref("");
const memberOptions = ref<Array<{ value: string; label: string }>>([]);
const labelOptions = ref<Array<{ value: string; label: string }>>([]);
const milestoneOptions = ref<Array<{ value: string; label: string }>>([]);

const titleMissing = computed(() => touched.value && !form.title.trim());
const descriptionMissing = computed(
  () => touched.value && !form.description.trim(),
);
const milestoneMissing = computed(
  () => touched.value && !form.milestone?.trim(),
);

const canSave = computed(
  () =>
    Boolean(
      !props.agentDrafting &&
        form.title.trim() &&
        form.description.trim() &&
        props.baProjectId,
    ),
);

const canPublish = computed(
  () => Boolean(canSave.value && form.milestone?.trim()),
);

function mergeAcIntoDescription(
  description: string,
  acceptanceCriteria: string[] | undefined,
): string {
  let text = description.trim();
  const ac = (acceptanceCriteria || []).map((s) => s.trim()).filter(Boolean);
  if (!ac.length || /###\s*Acceptance criteria/i.test(text)) return text;
  const parts = [text, "### Acceptance criteria", ...ac.map((line) => `- ${line}`)];
  return parts.filter(Boolean).join("\n\n");
}

function resetFromInitial() {
  form.title = props.initial?.title?.trim() || "";
  form.description = mergeAcIntoDescription(
    props.initial?.description || "",
    props.initial?.acceptanceCriteria,
  );
  form.labels = [...(props.initial?.labels || [])];
  form.devNotes = props.initial?.devNotes?.trim() || "";
  form.includeDevNotes = Boolean(props.initial?.includeDevNotes);
  form.assignee = props.initial?.assignee?.trim() || undefined;
  form.milestone = props.initial?.milestone?.trim() || undefined;
  publishMode.value = "update";
  touched.value = false;
  editorKey.value += 1;
}

async function loadGitlabMeta() {
  if (!props.baProjectId) return;
  metaLoading.value = true;
  metaError.value = "";
  try {
    const meta = await baApi.getProjectGitlabMeta(props.baProjectId);
    currentUser.value = meta.currentUser;
    memberOptions.value = meta.members.map((m) => ({
      value: m.username,
      label: m.name ? `${m.name} (@${m.username})` : `@${m.username}`,
    }));
    labelOptions.value = meta.labels.map((l) => ({
      value: l.name,
      label: l.name,
    }));
    milestoneOptions.value = meta.milestones.map((m) => ({
      value: m.title,
      label: m.title,
    }));
  } catch (e) {
    metaError.value = e instanceof Error ? e.message : String(e);
    if (!handleBaPatApiError(e, () => void loadGitlabMeta())) {
      void openPatModal(() => void loadGitlabMeta());
    }
  } finally {
    metaLoading.value = false;
  }
}

watch(
  () => props.initial,
  () => {
    if (props.open) resetFromInitial();
  },
  { deep: true },
);

watch(
  () => props.open,
  (v) => {
    if (v) {
      resetFromInitial();
      void loadGitlabMeta();
    }
  },
);

function payloadBase() {
  return {
    title: form.title.trim(),
    description: form.description.trim(),
    labels: [...form.labels],
    acceptanceCriteria: [] as string[],
    devNotes: form.devNotes.trim() || undefined,
    includeDevNotes: form.includeDevNotes,
    milestone: form.milestone?.trim() || undefined,
    assignee: form.assignee?.trim() || undefined,
    requirementId: props.initial?.requirementId,
    threadId: props.initial?.threadId,
    messageId: props.initial?.messageId,
  };
}

function onSave() {
  touched.value = true;
  if (!canSave.value) return;
  emit("save", payloadBase());
}

function onPublish() {
  touched.value = true;
  if (!canPublish.value) return;
  emit("publish", {
    ...payloadBase(),
    milestone: form.milestone!.trim(),
    mode: alreadyPublished.value ? publishMode.value : undefined,
  });
}

function close() {
  emit("update:open", false);
}
</script>

<template>
  <a-modal
    :open="open"
    title="Task draft"
    :width="760"
    :confirm-loading="loading || publishLoading"
    wrap-class-name="faw-ba-task-modal"
    destroy-on-close
    @cancel="close"
  >
    <a-spin
      :spinning="metaLoading || !!agentDrafting"
      :tip="
        agentDrafting
          ? agentDraftLabel || 'Agent đang soạn issue…'
          : undefined
      "
    >
      <div class="space-y-3">
        <a-alert
          v-if="metaError && !metaLoading"
          type="warning"
          show-icon
          class="text-[12px]"
          :message="metaError"
        />

        <div>
          <label class="faw-ba-label block mb-1">Tiêu đề *</label>
          <a-input
            v-model:value="form.title"
            placeholder="Title task GitLab"
            :disabled="agentDrafting"
            :status="titleMissing ? 'error' : undefined"
          />
          <p v-if="titleMissing" class="text-[11px] text-red-500 m-0 mt-1">
            Tiêu đề là bắt buộc
          </p>
        </div>

        <div>
          <label class="faw-ba-label block mb-1">Mô tả *</label>
          <BaIssueDescriptionEditor
            :key="editorKey"
            v-model="form.description"
            placeholder="Bối cảnh, phạm vi, ghi chú cho Dev…"
          />
          <p
            v-if="descriptionMissing"
            class="text-[11px] text-red-500 m-0 mt-1"
          >
            Mô tả là bắt buộc
          </p>
        </div>

        <div class="rounded-lg border border-dashed border-[var(--app-border)] p-3">
          <div class="flex items-center justify-between gap-2 mb-1">
            <label class="faw-ba-label m-0">Ghi chú kỹ thuật cho Dev (lưu riêng)</label>
            <span class="flex items-center gap-2 text-[11px] text-[var(--app-muted)]">
              Đưa lên task
              <a-switch
                v-model:checked="form.includeDevNotes"
                size="small"
                :disabled="agentDrafting"
              />
            </span>
          </div>
          <a-textarea
            v-model:value="form.devNotes"
            :rows="3"
            :disabled="agentDrafting"
            placeholder="Không bắt buộc — gợi ý kỹ thuật cho Dev, không xuất hiện trong mô tả nghiệp vụ"
          />
          <p class="text-[11px] text-[var(--app-muted)] m-0 mt-1">
            {{
              form.includeDevNotes
                ? "Sẽ thêm mục “Ghi chú kỹ thuật (cho Dev)” vào issue khi lên GitLab."
                : "Chỉ lưu nội bộ — không đưa vào issue GitLab."
            }}
          </p>
        </div>

        <div>
          <label class="faw-ba-label block mb-1">Assignee</label>
          <a-select
            v-model:value="form.assignee"
            class="w-full"
            allow-clear
            show-search
            :disabled="agentDrafting"
            :options="memberOptions"
            :placeholder="
              currentUser
                ? `Mặc định: bạn (@${currentUser})`
                : 'Không chọn → assign cho bạn'
            "
            option-filter-prop="label"
          />
        </div>

        <div>
          <label class="faw-ba-label block mb-1">Labels</label>
          <a-select
            v-model:value="form.labels"
            class="w-full"
            mode="multiple"
            allow-clear
            show-search
            :disabled="agentDrafting"
            :options="labelOptions"
            placeholder="Tùy chọn — chọn từ GitLab"
            option-filter-prop="label"
          />
        </div>

        <div>
          <label class="faw-ba-label block mb-1">Milestone *</label>
          <a-select
            v-model:value="form.milestone"
            class="w-full"
            allow-clear
            show-search
            :disabled="agentDrafting"
            :options="milestoneOptions"
            placeholder="Chọn milestone"
            option-filter-prop="label"
            :status="milestoneMissing ? 'error' : undefined"
          />
          <p v-if="milestoneMissing" class="text-[11px] text-red-500 m-0 mt-1">
            Milestone là bắt buộc khi lên GitLab
          </p>
        </div>

        <a-alert
          v-if="alreadyPublished"
          type="warning"
          show-icon
          class="text-[12px]"
        >
          <template #message>
            Task đã lên GitLab
            <a
              v-if="initial?.gitlabUrl"
              :href="initial.gitlabUrl"
              target="_blank"
              rel="noopener"
            >#{{ initial?.gitlabIid }}</a>
            <template v-else>#{{ initial?.gitlabIid }}</template>
            — chọn cách lên task
          </template>
          <template #description>
            <a-radio-group v-model:value="publishMode" size="small">
              <a-radio value="update">Cập nhật task cũ #{{ initial?.gitlabIid }}</a-radio>
              <a-radio value="new">Tạo task mới</a-radio>
            </a-radio-group>
          </template>
        </a-alert>
      </div>
    </a-spin>

    <template #footer>
      <button type="button" class="faw-btn" @click="close">Huỷ</button>
      <button
        type="button"
        class="faw-btn"
        :disabled="!canSave || loading"
        @click="onSave"
      >
        {{ loading ? "…" : "Lưu draft" }}
      </button>
      <button
        type="button"
        class="faw-btn faw-btn--run"
        :disabled="!canPublish || publishLoading"
        @click="onPublish"
      >
        {{
          publishLoading
            ? "…"
            : alreadyPublished && publishMode === "update"
              ? `Cập nhật task #${initial?.gitlabIid}`
              : "Lên GitLab"
        }}
      </button>
    </template>
  </a-modal>
</template>
