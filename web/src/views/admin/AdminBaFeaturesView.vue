<script setup lang="ts">
import { onMounted, ref } from "vue";
import { message } from "ant-design-vue";
import { api } from "@/api/client";
import { API } from "@/api/endpoints";

type FeatureState = "hide" | "lab" | "production";

type BaFeaturesResponse = {
  flags: { createIssue: FeatureState; workflow: FeatureState; tasks: FeatureState };
  workflowTabLabel: string;
  devMode: boolean;
  updatedAt: string | null;
};

const loading = ref(false);
const saving = ref(false);
const devMode = ref(false);
const workflowTabLabel = ref("Phân tích YC");
const flags = ref<Record<"createIssue" | "workflow" | "tasks", FeatureState>>({
  createIssue: "hide",
  workflow: "hide",
  tasks: "hide",
});

const STATE_OPTIONS: { value: FeatureState; label: string }[] = [
  { value: "hide", label: "Hide — ẩn hoàn toàn" },
  { value: "lab", label: "Lab — hiện kèm nhãn (lab)" },
  { value: "production", label: "Production — hiện bình thường" },
];

const FEATURES: { key: "createIssue" | "workflow" | "tasks"; name: string; desc: string }[] = [
  {
    key: "createIssue",
    name: "Create issue (BA Chat)",
    desc: "Nút tạo issue GitLab từ hội thoại chat.",
  },
  {
    key: "workflow",
    name: "Phân tích YC",
    desc: "Tab phân tích yêu cầu: YC gốc → làm rõ → hiện trạng → đề xuất → kết quả (task).",
  },
  {
    key: "tasks",
    name: "Tasks",
    desc: "Tab quản lý task draft và đưa lên GitLab.",
  },
];

async function load() {
  loading.value = true;
  try {
    const data = await api<BaFeaturesResponse>(API.admin.baFeatures);
    flags.value = { ...data.flags };
    workflowTabLabel.value = data.workflowTabLabel || "Phân tích YC";
    devMode.value = Boolean(data.devMode);
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  } finally {
    loading.value = false;
  }
}

async function save() {
  saving.value = true;
  try {
    await api(API.admin.baFeatures, {
      method: "PUT",
      body: JSON.stringify({
        ...flags.value,
        workflowTabLabel: workflowTabLabel.value.trim(),
      }),
    });
    message.success("Đã lưu cấu hình tính năng BA");
    await load();
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  } finally {
    saving.value = false;
  }
}

onMounted(() => {
  void load();
});
</script>

<template>
  <div class="max-w-2xl mx-auto px-4 py-6">
    <h1 class="text-xl font-semibold text-ink m-0 mb-1">Tính năng BA</h1>
    <p class="text-sm text-ink-muted mb-4">
      Đóng / mở từng tính năng cho người dùng BA. Chat và BA mode luôn mở.
    </p>

    <a-alert
      v-if="devMode"
      type="info"
      show-icon
      class="mb-4"
      message="Đang chạy dev mode (DEV=true hoặc PRODUCTION=false) — mọi tính năng đều hiện cho dev, bất kể cấu hình bên dưới. Cấu hình này vẫn áp dụng khi lên production."
    />

    <div class="p-4 rounded-lg border border-line bg-surface-raised space-y-5">
      <div
        v-for="f in FEATURES"
        :key="f.key"
        class="flex flex-col gap-1.5 pb-4 border-b border-line last:border-b-0 last:pb-0"
      >
        <div class="flex items-center justify-between gap-3">
          <div class="min-w-0">
            <div class="text-sm font-medium text-ink">{{ f.name }}</div>
            <div class="text-xs text-ink-muted">{{ f.desc }}</div>
          </div>
          <a-select
            v-model:value="flags[f.key]"
            :options="STATE_OPTIONS"
            :disabled="loading"
            class="w-60 shrink-0"
          />
        </div>

        <label
          v-if="f.key === 'workflow'"
          class="flex flex-col gap-1 text-sm mt-2"
        >
          <span class="text-ink-muted">Tên hiển thị tab workflow</span>
          <a-input
            v-model:value="workflowTabLabel"
            placeholder="Phân tích YC"
            class="max-w-xs"
          />
        </label>
      </div>

      <button
        type="button"
        class="faw-btn faw-btn--run"
        :disabled="saving || loading"
        @click="save"
      >
        {{ saving ? "Đang lưu…" : "Lưu cấu hình" }}
      </button>
    </div>
  </div>
</template>
