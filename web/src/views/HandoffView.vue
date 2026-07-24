<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { message } from "ant-design-vue";
import { storeToRefs } from "pinia";
import { api } from "@/api/client";
import { useSettingsStore } from "@/stores/settings";
import { useWorkStore } from "@/stores/work";

const work = useWorkStore();
const settings = useSettingsStore();
const { jobs, members, labels } = storeToRefs(work);

const selectedId = ref<string | null>(null);
const busy = ref(false);
const assignee = ref<string | undefined>(
  settings.local.assignee || undefined,
);
const addLabels = ref<string[]>([...settings.local.addLabels]);
const comment = ref(settings.local.comment);

const handoffJobs = computed(() =>
  jobs.value
    .filter((j) => j.status === "awaiting_handoff")
    .slice()
    .sort((a, b) => {
      const ub = Date.parse(b.updatedAt || "") || 0;
      const ua = Date.parse(a.updatedAt || "") || 0;
      if (ub !== ua) return ub - ua;
      const cb = Date.parse(b.createdAt || "") || 0;
      const ca = Date.parse(a.createdAt || "") || 0;
      return cb - ca;
    }),
);

const selected = computed(
  () => jobs.value.find((j) => j.id === selectedId.value) || null,
);

onMounted(async () => {
  await work.loadJobs();
  await work.loadMeta();
});

async function confirmHandoff() {
  if (!selectedId.value) return;
  busy.value = true;
  try {
    await api(`/api/jobs/${selectedId.value}/completion-actions`, {
      method: "POST",
      body: JSON.stringify({
        assignees: assignee.value ? [assignee.value] : [],
        labels: addLabels.value,
        removeLabels: settings.local.removeLabels || [],
        comment: comment.value || undefined,
        labelMode: "add",
      }),
    });
    message.success("Handoff OK");
    selectedId.value = null;
    await work.loadJobs();
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  } finally {
    busy.value = false;
  }
}

async function mergeBranch() {
  if (!selectedId.value) return;
  busy.value = true;
  try {
    await api(`/api/jobs/${selectedId.value}/merge`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    message.success("Merge OK");
    await work.loadJobs();
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="h-full max-h-full grid grid-cols-12 gap-3 p-3 min-h-0 overflow-hidden">
    <aside
      class="col-span-4 min-h-0 overflow-y-auto p-3 rounded-2xl panel-glass shadow-panel"
    >
      <h2
        class="text-sm font-semibold text-ink mb-3 sticky top-0 bg-surface-raised/90 py-1 backdrop-blur"
      >
        Done chờ (awaiting_handoff)
      </h2>
      <div
        v-for="j in handoffJobs"
        :key="j.id"
        class="rounded-xl border border-line p-3 mb-2 cursor-pointer hover:border-accent/50 bg-surface-raised/60 transition"
        :class="
          selectedId === j.id ? '!border-accent !bg-accent-soft shadow-sm' : ''
        "
        @click="selectedId = j.id"
      >
        <div class="text-accent text-xs font-semibold">
          #{{ j.issue?.issueIid }}
        </div>
        <div class="text-sm text-ink-soft">{{ j.issue?.title }}</div>
        <div class="text-xs text-ink-faint mt-1 truncate">
          {{ j.summary || j.branch || j.id }}
        </div>
      </div>
      <a-empty v-if="!handoffJobs.length" description="Không có job chờ" />
    </aside>

    <section
      class="col-span-8 min-h-0 overflow-y-auto p-4 rounded-2xl panel-glass shadow-panel"
    >
      <template v-if="selected">
        <h2 class="text-lg font-semibold text-ink mt-0">
          #{{ selected.issue?.issueIid }} — {{ selected.issue?.title }}
        </h2>
        <p class="text-sm text-ink-muted whitespace-pre-wrap">
          {{ selected.summary || "—" }}
        </p>
        <a-form layout="vertical" class="max-w-lg mt-4">
          <a-form-item label="Assign">
            <a-select
              v-model:value="assignee"
              allow-clear
              show-search
              class="w-full"
              :options="
                members.map((m) => ({
                  value: m.username,
                  label: `@${m.username}`,
                }))
              "
            />
          </a-form-item>
          <a-form-item label="Add labels">
            <a-select
              v-model:value="addLabels"
              mode="multiple"
              class="w-full"
              :options="labels.map((l) => ({ value: l, label: l }))"
            />
          </a-form-item>
          <a-form-item label="Comment">
            <a-textarea v-model:value="comment" :rows="2" />
          </a-form-item>
          <div class="flex gap-2">
            <a-button :loading="busy" @click="mergeBranch"
              >Merge → project</a-button
            >
            <a-button type="primary" :loading="busy" @click="confirmHandoff"
              >Xác nhận handoff</a-button
            >
          </div>
        </a-form>
      </template>
      <a-empty v-else description="Chọn job bên trái" />
    </section>
  </div>
</template>
