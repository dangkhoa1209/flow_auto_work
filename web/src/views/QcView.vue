<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from "vue";
import { message } from "ant-design-vue";
import {
  getStoredQcProjectId,
  qcApi,
  setStoredQcProjectId,
  type QcFlow,
  type QcProject,
  type QcTestCase,
} from "@/api/qcApi";
import { useSessionStore } from "@/stores/session";

const session = useSessionStore();
const loading = ref(false);
const projects = ref<QcProject[]>([]);
const flows = ref<QcFlow[]>([]);
const testCases = ref<QcTestCase[]>([]);
const selectedProjectId = ref(getStoredQcProjectId() || "");
const tab = ref("flows");

const projectForm = reactive({ name: "", targetBaseUrl: "" });
const flowForm = reactive({ name: "" });
const tcForm = reactive({ name: "", loopCount: 1 });

const selectedProject = computed(() =>
  projects.value.find((p) => p._id === selectedProjectId.value),
);

async function loadProjects() {
  const res = await qcApi.listProjects();
  projects.value = res.projects || [];
  if (
    selectedProjectId.value &&
    !projects.value.some((p) => p._id === selectedProjectId.value)
  ) {
    selectedProjectId.value = projects.value[0]?._id || "";
  }
  if (!selectedProjectId.value && projects.value[0]) {
    selectedProjectId.value = projects.value[0]._id;
  }
  setStoredQcProjectId(selectedProjectId.value || null);
}

async function loadScoped() {
  if (!selectedProjectId.value) {
    flows.value = [];
    testCases.value = [];
    return;
  }
  setStoredQcProjectId(selectedProjectId.value);
  const [f, t] = await Promise.all([
    qcApi.listFlows(selectedProjectId.value),
    qcApi.listTestCases(selectedProjectId.value),
  ]);
  flows.value = f.flows || [];
  testCases.value = t.testCases || [];
}

async function refreshAll() {
  loading.value = true;
  try {
    await loadProjects();
    await loadScoped();
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err));
  } finally {
    loading.value = false;
  }
}

async function createProject() {
  try {
    const p = await qcApi.createProject({ ...projectForm });
    projectForm.name = "";
    projectForm.targetBaseUrl = "";
    selectedProjectId.value = p._id;
    message.success("QC project created");
    await refreshAll();
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err));
  }
}

async function createFlow() {
  if (!selectedProjectId.value) return;
  try {
    await qcApi.createFlow(
      { name: flowForm.name, steps: [] },
      selectedProjectId.value,
    );
    flowForm.name = "";
    message.success("Flow created — record steps in the Chrome extension");
    await loadScoped();
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err));
  }
}

async function createTestCase() {
  if (!selectedProjectId.value) return;
  try {
    await qcApi.createTestCase(
      {
        name: tcForm.name,
        loopCount: tcForm.loopCount,
        executionPlan: [],
      },
      selectedProjectId.value,
    );
    tcForm.name = "";
    tcForm.loopCount = 1;
    message.success("Test case created");
    await loadScoped();
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err));
  }
}

async function removeFlow(id: string) {
  await qcApi.deleteFlow(id, selectedProjectId.value);
  await loadScoped();
}

async function removeTc(id: string) {
  await qcApi.deleteTestCase(id, selectedProjectId.value);
  await loadScoped();
}

async function removeProject(id: string) {
  await qcApi.deleteProject(id);
  if (selectedProjectId.value === id) selectedProjectId.value = "";
  await refreshAll();
}

watch(selectedProjectId, () => {
  void loadScoped();
});

onMounted(() => {
  if (session.isQc) void refreshAll();
});
</script>

<template>
  <div class="space-y-4 p-4 max-w-5xl mx-auto">
    <div class="flex items-start justify-between gap-3 flex-wrap">
      <div>
        <h1 class="text-xl font-semibold m-0">QC Automation</h1>
        <p class="text-sm text-ink-muted m-0 mt-1">
          Manage flows &amp; test cases. Record / Play runs in the Chrome
          extension (load
          <code class="text-xs">extension/</code>
          unpacked).
        </p>
      </div>
      <a-button :loading="loading" @click="refreshAll">Refresh</a-button>
    </div>

    <a-alert
      v-if="!session.isQc"
      type="warning"
      show-icon
      message="Enable “I am QC” in Settings → Account to use this area."
    />

    <template v-else>
      <a-card size="small" title="QC projects">
        <div class="flex flex-wrap gap-2 mb-3 items-end">
          <a-input
            v-model:value="projectForm.name"
            placeholder="Name"
            class="!w-40"
          />
          <a-input
            v-model:value="projectForm.targetBaseUrl"
            placeholder="Target base URL (e.g. https://hr.local)"
            class="!w-72"
          />
          <a-button type="primary" @click="createProject">Add project</a-button>
        </div>
        <a-select
          v-model:value="selectedProjectId"
          class="!w-full max-w-md"
          placeholder="Select QC project"
          :options="
            projects.map((p) => ({
              value: p._id,
              label: `${p.name} — ${p.targetBaseUrl}`,
            }))
          "
        />
        <div
          v-if="selectedProject"
          class="mt-2 text-xs text-ink-muted flex gap-3 items-center"
        >
          <span>ID: {{ selectedProject._id }}</span>
          <a-button
            size="small"
            danger
            type="link"
            @click="removeProject(selectedProject._id)"
          >
            Delete project
          </a-button>
        </div>
      </a-card>

      <a-tabs v-model:activeKey="tab">
        <a-tab-pane key="flows" tab="Flows">
          <div class="flex gap-2 mb-3">
            <a-input
              v-model:value="flowForm.name"
              placeholder="Flow name"
              class="!w-56"
            />
            <a-button
              type="primary"
              :disabled="!selectedProjectId"
              @click="createFlow"
            >
              Create flow
            </a-button>
          </div>
          <a-table
            size="small"
            row-key="_id"
            :pagination="false"
            :data-source="flows"
            :columns="[
              { title: 'Name', dataIndex: 'name' },
              { title: 'Steps', key: 'steps' },
              { title: 'Updated', dataIndex: 'updatedAt' },
              { title: '', key: 'actions', width: 90 },
            ]"
          >
            <template #bodyCell="{ column, record }">
              <template v-if="column.key === 'steps'">
                {{ record.steps?.length || 0 }}
              </template>
              <template v-else-if="column.key === 'actions'">
                <a-button
                  type="link"
                  danger
                  size="small"
                  @click="removeFlow(record._id)"
                >
                  Delete
                </a-button>
              </template>
            </template>
          </a-table>
        </a-tab-pane>

        <a-tab-pane key="cases" tab="Test cases">
          <div class="flex gap-2 mb-3 flex-wrap">
            <a-input
              v-model:value="tcForm.name"
              placeholder="Test case name"
              class="!w-56"
            />
            <a-input-number
              v-model:value="tcForm.loopCount"
              :min="1"
              :max="1000"
            />
            <a-button
              type="primary"
              :disabled="!selectedProjectId"
              @click="createTestCase"
            >
              Create test case
            </a-button>
          </div>
          <a-table
            size="small"
            row-key="_id"
            :pagination="false"
            :data-source="testCases"
            :columns="[
              { title: 'Name', dataIndex: 'name' },
              { title: 'Loops', dataIndex: 'loopCount' },
              { title: 'Plan', key: 'plan' },
              { title: '', key: 'actions', width: 90 },
            ]"
          >
            <template #bodyCell="{ column, record }">
              <template v-if="column.key === 'plan'">
                {{ record.executionPlan?.length || 0 }} items
              </template>
              <template v-else-if="column.key === 'actions'">
                <a-button
                  type="link"
                  danger
                  size="small"
                  @click="removeTc(record._id)"
                >
                  Delete
                </a-button>
              </template>
            </template>
          </a-table>
        </a-tab-pane>
      </a-tabs>
    </template>
  </div>
</template>
