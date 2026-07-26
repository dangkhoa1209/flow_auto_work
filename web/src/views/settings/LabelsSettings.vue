<script setup lang="ts">
import { onMounted, ref } from "vue";
import { message } from "ant-design-vue";
import { storeToRefs } from "pinia";
import { useSettingsStore } from "@/stores/settings";
import { useWorkStore } from "@/stores/work";

const settings = useSettingsStore();
const work = useWorkStore();
const { local } = storeToRefs(settings);

const processingLabel = ref(local.value.processingLabel);
const onStartLabels = ref<string[]>([...local.value.onStartLabels]);
const assignee = ref<string | undefined>(local.value.assignee || undefined);
const addLabels = ref<string[]>([...local.value.addLabels]);
const removeLabels = ref<string[]>([...local.value.removeLabels]);
const comment = ref(local.value.comment);

onMounted(async () => {
  if (!work.labels.length || !work.members.length) {
    await work.loadMeta().catch(() => undefined);
  }
});

function save() {
  settings.update({
    processingLabel: processingLabel.value.trim() || "On-processing",
    onStartLabels: onStartLabels.value,
    assignee: assignee.value || null,
    addLabels: addLabels.value,
    removeLabels: removeLabels.value,
    comment: comment.value,
  });
  message.success("Labels / handoff prefs saved");
}
</script>

<template>
  <div class="space-y-4">
    <h2 class="text-lg font-medium m-0">Labels & handoff</h2>
    <p class="text-sm text-ink-muted m-0">
      Prefill on Start / Done awaiting handoff — does not auto-assign.
    </p>
    <a-form layout="vertical">
      <a-form-item label="In-progress label (Start + / handoff −)">
        <a-input v-model:value="processingLabel" placeholder="On-processing" />
      </a-form-item>
      <a-form-item label="Add labels on Start">
        <a-select
          v-model:value="onStartLabels"
          mode="multiple"
          class="w-full"
          :options="work.labels.map((l) => ({ value: l, label: l }))"
          placeholder="Select labels…"
        />
      </a-form-item>
      <a-divider>Prefill handoff QC</a-divider>
      <a-form-item label="Assign (1 person)">
        <a-select
          v-model:value="assignee"
          allow-clear
          show-search
          class="w-full"
          :options="
            work.members.map((m) => ({
              value: m.username,
              label: m.name ? `${m.name} (@${m.username})` : `@${m.username}`,
            }))
          "
        />
      </a-form-item>
      <a-form-item label="Add labels">
        <a-select
          v-model:value="addLabels"
          mode="multiple"
          class="w-full"
          :options="work.labels.map((l) => ({ value: l, label: l }))"
        />
      </a-form-item>
      <a-form-item label="Remove labels">
        <a-select
          v-model:value="removeLabels"
          mode="multiple"
          class="w-full"
          :options="work.labels.map((l) => ({ value: l, label: l }))"
        />
      </a-form-item>
      <a-form-item label="Comment (optional)">
        <a-textarea v-model:value="comment" :rows="2" />
      </a-form-item>
      <a-button type="primary" @click="save">Save</a-button>
    </a-form>
  </div>
</template>
