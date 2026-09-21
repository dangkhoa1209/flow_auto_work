<script setup lang="ts">
import { onMounted, ref } from "vue";
import { message } from "ant-design-vue";
import { api } from "@/api/client";
import { API } from "@/api/endpoints";

type FeatureState = "hide" | "lab" | "production";

type FeatureKey =
  | "createIssue"
  | "workflow"
  | "tasks"
  | "syncDatabase"
  | "createData";

type BaFeaturesResponse = {
  flags: Record<FeatureKey, FeatureState>;
  workflowTabLabel: string;
  devMode: boolean;
  updatedAt: string | null;
};

const loading = ref(false);
const saving = ref(false);
const devMode = ref(false);
const workflowTabLabel = ref("Requirements");
const flags = ref<Record<FeatureKey, FeatureState>>({
  createIssue: "hide",
  workflow: "hide",
  tasks: "hide",
  syncDatabase: "hide",
  createData: "hide",
});

const STATE_OPTIONS: { value: FeatureState; label: string }[] = [
  { value: "hide", label: "Hide — fully hidden" },
  { value: "lab", label: "Lab — visible with (lab) badge" },
  { value: "production", label: "Production — fully visible" },
];

const FEATURES: {
  key: FeatureKey;
  name: string;
  desc: string;
}[] = [
  {
    key: "createIssue",
    name: "Create issue (BA Chat)",
    desc: "Button to create a GitLab issue from chat.",
  },
  {
    key: "workflow",
    name: "Requirements analysis",
    desc: "Requirements tab: source → clarify → current state → proposal → result (tasks).",
  },
  {
    key: "tasks",
    name: "Tasks",
    desc: "Tab to manage task drafts and publish to GitLab.",
  },
  {
    key: "syncDatabase",
    name: "Sync Database",
    desc: "Header control to dump live Mongo → restore project Connect DB (system Sync DB config required).",
  },
  {
    key: "createData",
    name: "Create Data",
    desc: "Seed test data via Connect DB write (plan → preview → insert/update). Never targets production.",
  },
];

async function load() {
  loading.value = true;
  try {
    const data = await api<BaFeaturesResponse>(API.admin.baFeatures);
    flags.value = { ...data.flags };
    workflowTabLabel.value = data.workflowTabLabel || "Requirements";
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
    message.success("BA features saved");
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
  <div class="faw-admin-page faw-admin-page--narrow">
    <header class="faw-admin-page__head">
      <div>
        <h1 class="faw-admin-page__title">BA features</h1>
        <p class="faw-admin-page__desc">
          Toggle features for BA users. Chat and BA mode stay always on.
        </p>
      </div>
    </header>

    <a-alert
      v-if="devMode"
      type="info"
      show-icon
      class="mb-4"
      message="Running in dev mode (DEV=true or PRODUCTION=false) — all features are visible to developers regardless of settings below. These settings still apply in production."
    />

    <div class="faw-admin-panel space-y-5">
      <div
        v-for="f in FEATURES"
        :key="f.key"
        class="flex flex-col gap-1.5 pb-4 border-b border-line last:border-b-0 last:pb-0"
      >
        <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div class="min-w-0">
            <div class="text-sm font-medium text-ink">{{ f.name }}</div>
            <div class="text-xs text-ink-muted">{{ f.desc }}</div>
          </div>
          <a-select
            v-model:value="flags[f.key]"
            :options="STATE_OPTIONS"
            :disabled="loading"
            class="w-full sm:w-60 shrink-0"
          />
        </div>

        <label
          v-if="f.key === 'workflow'"
          class="flex flex-col gap-1 text-sm mt-2"
        >
          <span class="text-ink-muted">Workflow tab label</span>
          <a-input
            v-model:value="workflowTabLabel"
            placeholder="Requirements"
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
        {{ saving ? "Saving…" : "Save settings" }}
      </button>
    </div>
  </div>
</template>
