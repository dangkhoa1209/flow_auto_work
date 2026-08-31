<script setup lang="ts">
import { onMounted, ref } from "vue";
import { message } from "ant-design-vue";
import { api } from "@/api/client";
import { API } from "@/api/endpoints";

type TaskTypeLabels = {
  bug: string[];
  feature: string[];
  refactor: string[];
  chore: string[];
};

const loading = ref(false);
const saving = ref(false);
const updatedAt = ref<string | null>(null);

const form = ref<TaskTypeLabels>({
  bug: [],
  feature: [],
  refactor: [],
  chore: [],
});

const rows: Array<{ key: keyof TaskTypeLabels; label: string; hint: string }> = [
  {
    key: "bug",
    label: "Bug fix",
    hint: "e.g. bug, fix, hotfix, type::bug",
  },
  {
    key: "feature",
    label: "Feature",
    hint: "e.g. feature, enhancement, story",
  },
  {
    key: "refactor",
    label: "Refactor",
    hint: "e.g. refactor, cleanup",
  },
  {
    key: "chore",
    label: "Chore / CI",
    hint: "e.g. chore, maintenance, ci, docs",
  },
];

async function load() {
  loading.value = true;
  try {
    const data = await api<{
      taskTypeLabels?: TaskTypeLabels;
      updatedAt?: string;
    }>(API.admin.taskTypeLabels);
    form.value = {
      bug: [...(data.taskTypeLabels?.bug ?? [])],
      feature: [...(data.taskTypeLabels?.feature ?? [])],
      refactor: [...(data.taskTypeLabels?.refactor ?? [])],
      chore: [...(data.taskTypeLabels?.chore ?? [])],
    };
    updatedAt.value = data.updatedAt ?? null;
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  } finally {
    loading.value = false;
  }
}

async function save() {
  saving.value = true;
  try {
    const data = await api<{
      taskTypeLabels?: TaskTypeLabels;
      taskTypeLabelsUpdatedAt?: string | null;
    }>(API.admin.taskTypeLabels, {
      method: "PUT",
      body: JSON.stringify(form.value),
    });
    if (data.taskTypeLabels) {
      form.value = {
        bug: [...data.taskTypeLabels.bug],
        feature: [...data.taskTypeLabels.feature],
        refactor: [...data.taskTypeLabels.refactor],
        chore: [...data.taskTypeLabels.chore],
      };
    }
    updatedAt.value = data.taskTypeLabelsUpdatedAt ?? null;
    message.success("Label mapping saved");
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  } finally {
    saving.value = false;
  }
}

function fmtUpdated(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Intl.DateTimeFormat("en-US", {
      dateStyle: "short",
      timeStyle: "short",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

onMounted(() => {
  void load();
});
</script>

<template>
  <div class="max-w-2xl mx-auto px-4 py-6">
    <h1 class="text-xl font-semibold text-ink m-0 mb-1">Task types (Stats)</h1>
    <p class="text-sm text-ink-muted mb-2">
      Map GitLab labels → task types used for stats and developer review.
    </p>
    <p class="text-sm text-ink-muted mb-6">
      Tasks with <strong>no GitLab label</strong> are treated as
      <strong>Feature</strong>. Enter exact GitLab label names (free-form tags).
    </p>

    <div
      v-if="loading"
      class="text-sm text-ink-muted py-8 text-center"
    >
      Loading…
    </div>

    <div
      v-else
      class="p-4 rounded-lg border border-line bg-surface-raised space-y-5"
    >
      <div
        v-for="row in rows"
        :key="row.key"
        class="space-y-1"
      >
        <label class="block text-sm font-medium text-ink">{{ row.label }}</label>
        <p class="text-xs text-ink-muted m-0">{{ row.hint }}</p>
        <a-select
          v-model:value="form[row.key]"
          mode="tags"
          class="w-full"
          :token-separators="[',']"
          placeholder="Select or type labels…"
        />
      </div>

      <div class="flex flex-wrap items-center gap-3 pt-2 border-t border-line">
        <button
          type="button"
          class="faw-btn faw-btn--run"
          :disabled="saving"
          @click="save"
        >
          {{ saving ? "Saving…" : "Save mapping" }}
        </button>
        <span class="text-xs text-ink-muted">
          Last updated: {{ fmtUpdated(updatedAt) }}
        </span>
      </div>
    </div>
  </div>
</template>
