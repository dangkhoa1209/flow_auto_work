<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import type { ExecutionState, QcStep } from "../shared/types";
import { expandStepValue } from "../shared/faker-expand";
import {
  enableQcRole,
  fetchMe,
  getFlow,
  listFlows,
  listProjects,
  listTestCases,
  loadConfig,
  login,
  logoutLocal,
  saveConfig,
  saveFlow,
  type ExtConfig,
} from "./api";

const cfg = ref<ExtConfig>({
  accessToken: "",
  refreshToken: "",
  username: "",
  qcProjectId: "",
});
const username = ref("");
const password = ref("");
const status = ref("idle");
const error = ref("");
const recorded = ref<QcStep[]>([]);
const flows = ref<{ _id: string; name: string; steps: QcStep[] }[]>([]);
const testCases = ref<
  {
    _id: string;
    name: string;
    loopCount: number;
    executionPlan: Array<
      | { type: "navigate"; url: string }
      | { type: "run_flow"; flowId: string }
    >;
  }[]
>([]);
const projects = ref<{ _id: string; name: string; targetBaseUrl: string }[]>(
  [],
);
const flowName = ref("Recorded flow");
const loopCount = ref(1);
const selectedFlowId = ref("");
const selectedTcId = ref("");
const busy = ref(false);
const isQc = ref(false);

const loggedIn = computed(() => Boolean(cfg.value.accessToken));

async function activeTabId(): Promise<number> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  const id = tab?.id;
  if (id == null) throw new Error("No active tab");
  const url = tab.url || "";
  if (/^(chrome|chrome-extension|edge|about|devtools):/i.test(url)) {
    throw new Error(
      "Đang ở trang hệ thống Chrome — hãy click sang tab web app (http/https) trước khi Record/Play.",
    );
  }
  return id;
}

async function refreshState() {
  const res = (await chrome.runtime.sendMessage({ type: "GET_STATE" })) as {
    state?: ExecutionState;
  };
  status.value = res.state?.status || "idle";
  error.value = res.state?.lastError || "";
}

async function persistCfg() {
  await saveConfig(cfg.value);
}

async function onLogin() {
  busy.value = true;
  error.value = "";
  try {
    const res = await login(username.value.trim(), password.value);
    cfg.value = {
      ...cfg.value,
      accessToken: res.accessToken,
      refreshToken: res.refreshToken,
      username:
        res.user?.gitlabUsername || username.value.trim().replace(/^@/, ""),
    };
    password.value = "";
    await persistCfg();

    const roles = res.user?.roles || [];
    if (!roles.includes("qc")) {
      await enableQcRole(cfg.value);
    }
    isQc.value = true;

    await loadLists();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    busy.value = false;
  }
}

async function onLogout() {
  cfg.value = await logoutLocal(cfg.value);
  projects.value = [];
  flows.value = [];
  testCases.value = [];
  isQc.value = false;
  error.value = "";
}

async function loadLists() {
  if (!cfg.value.accessToken) return;
  try {
    const me = await fetchMe(cfg.value);
    isQc.value = Boolean(me.user?.roles?.includes("qc"));
    if (!isQc.value) {
      await enableQcRole(cfg.value);
      isQc.value = true;
    }
    const p = await listProjects(cfg.value);
    projects.value = p.projects || [];
    if (
      cfg.value.qcProjectId &&
      !projects.value.some((x) => x._id === cfg.value.qcProjectId)
    ) {
      cfg.value.qcProjectId = "";
    }
    if (!cfg.value.qcProjectId && projects.value[0]) {
      cfg.value.qcProjectId = projects.value[0]._id;
      await persistCfg();
    }
    if (!cfg.value.qcProjectId) return;
    const [f, t] = await Promise.all([
      listFlows(cfg.value),
      listTestCases(cfg.value),
    ]);
    flows.value = f.flows || [];
    testCases.value = t.testCases || [];
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

async function startRecord() {
  busy.value = true;
  error.value = "";
  try {
    await persistCfg();
    const tabId = await activeTabId();
    recorded.value = [];
    const res = (await chrome.runtime.sendMessage({
      type: "START_RECORD",
      tabId,
    })) as { ok?: boolean; error?: string };
    if (res && res.ok === false) {
      throw new Error(res.error || "Start record failed");
    }
    await refreshState();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    busy.value = false;
  }
}

async function stopRecord() {
  await chrome.runtime.sendMessage({ type: "STOP_RECORD" });
  const res = (await chrome.runtime.sendMessage({
    type: "GET_RECORDED_STEPS",
  })) as { steps?: QcStep[] };
  recorded.value = res.steps || [];
  await refreshState();
}

async function saveRecorded() {
  if (!recorded.value.length) return;
  busy.value = true;
  try {
    await persistCfg();
    await saveFlow(cfg.value, {
      name: flowName.value || "Recorded flow",
      steps: recorded.value,
    });
    await loadLists();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    busy.value = false;
  }
}

function expandSteps(steps: QcStep[]): QcStep[] {
  return steps.map((s) => expandStepValue(s));
}

async function buildPlanFromTestCase(): Promise<QcStep[]> {
  const tc = testCases.value.find((t) => t._id === selectedTcId.value);
  if (!tc) throw new Error("Select a test case");
  const out: QcStep[] = [];
  for (const item of tc.executionPlan || []) {
    if (item.type === "navigate") {
      out.push({ action: "navigate", url: item.url });
    } else if (item.type === "run_flow") {
      const flow = await getFlow(cfg.value, item.flowId);
      out.push(...(flow.steps || []));
    }
  }
  loopCount.value = tc.loopCount || 1;
  return out;
}

async function playSteps(steps: QcStep[], loops = 1) {
  busy.value = true;
  error.value = "";
  try {
    await persistCfg();
    const tabId = await activeTabId();
    const expanded: QcStep[] = [];
    for (let i = 0; i < Math.max(1, loops); i++) {
      expanded.push(...expandSteps(steps));
    }
    const res = (await chrome.runtime.sendMessage({
      type: "PLAY_PLAN",
      tabId,
      steps: expanded,
      loopTotal: 1,
    })) as { ok?: boolean; error?: string };
    if (res && res.ok === false) {
      throw new Error(res.error || "Play failed");
    }
    await refreshState();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    busy.value = false;
  }
}

async function playSelectedFlow() {
  const flow = flows.value.find((f) => f._id === selectedFlowId.value);
  if (!flow) {
    error.value = "Select a flow";
    return;
  }
  await playSteps(flow.steps || [], loopCount.value);
}

async function playSelectedTc() {
  const steps = await buildPlanFromTestCase();
  await playSteps(steps, 1);
}

async function playRecorded() {
  await playSteps(recorded.value, loopCount.value);
}

async function stopAll() {
  await chrome.runtime.sendMessage({ type: "STOP" });
  await refreshState();
}

function onStorage(
  changes: { [key: string]: chrome.storage.StorageChange },
  area: string,
) {
  if (area !== "session") return;
  if (changes.qcLastRecorded?.newValue) {
    recorded.value = [
      ...recorded.value,
      changes.qcLastRecorded.newValue as QcStep,
    ];
  }
  if (changes.qcExecutionState) void refreshState();
}

onMounted(async () => {
  cfg.value = await loadConfig();
  username.value = cfg.value.username;
  await persistCfg();
  await refreshState();
  if (loggedIn.value) await loadLists();
  chrome.storage.onChanged.addListener(onStorage);
});

onUnmounted(() => {
  chrome.storage.onChanged.removeListener(onStorage);
});

watch(
  () => cfg.value.qcProjectId,
  () => {
    if (loggedIn.value) void loadLists();
  },
);
</script>

<template>
  <div class="wrap">
    <h1>Flow QC</h1>
    <p class="muted">Status: <strong>{{ status }}</strong></p>
    <p v-if="error" class="err">{{ error }}</p>

    <section>
      <h2>Login WorkBench</h2>

      <template v-if="!loggedIn">
        <label>Username <input v-model="username" autocomplete="username" /></label>
        <label>
          Password
          <input
            v-model="password"
            type="password"
            autocomplete="current-password"
            @keyup.enter="onLogin"
          />
        </label>
        <button :disabled="busy || !username || !password" @click="onLogin">
          Login
        </button>
        <p class="muted tip">
          Cùng tài khoản với web WorkBench (cùng backend).
        </p>
      </template>

      <template v-else>
        <p class="ok">
          Signed in as <strong>@{{ cfg.username }}</strong>
          <span v-if="isQc"> · QC</span>
        </p>
        <label>
          QC project
          <select v-model="cfg.qcProjectId" @change="persistCfg">
            <option disabled value="">Select…</option>
            <option v-for="p in projects" :key="p._id" :value="p._id">
              {{ p.name }}
            </option>
          </select>
        </label>
        <p v-if="!projects.length" class="muted tip">
          Chưa có QC project — tạo ở web
          <code>/qc</code>
          rồi bấm Reload lists.
        </p>
        <div class="row">
          <button :disabled="busy" @click="loadLists">Reload lists</button>
          <button class="ghost" :disabled="busy" @click="onLogout">Logout</button>
        </div>
      </template>
    </section>

    <template v-if="loggedIn">
      <section>
        <h2>Record</h2>
        <div class="row">
          <button :disabled="busy" @click="startRecord">Start</button>
          <button :disabled="busy" @click="stopRecord">Stop</button>
          <button :disabled="busy || !recorded.length" @click="saveRecorded">
            Save flow
          </button>
        </div>
        <label>Flow name <input v-model="flowName" /></label>
        <ol class="steps">
          <li v-for="(s, i) in recorded" :key="i">
            {{ s.action }}
            <span class="muted">
              {{
                s.selectorContext?.textContent ||
                s.selectorContext?.primarySelector ||
                s.url ||
                s.value
              }}
            </span>
          </li>
        </ol>
      </section>

      <section>
        <h2>Playback</h2>
        <label>
          Loops
          <input v-model.number="loopCount" type="number" min="1" max="1000" />
        </label>
        <label>
          Flow
          <select v-model="selectedFlowId">
            <option value="">—</option>
            <option v-for="f in flows" :key="f._id" :value="f._id">
              {{ f.name }} ({{ f.steps?.length || 0 }})
            </option>
          </select>
        </label>
        <label>
          Test case
          <select v-model="selectedTcId">
            <option value="">—</option>
            <option v-for="t in testCases" :key="t._id" :value="t._id">
              {{ t.name }} ×{{ t.loopCount }}
            </option>
          </select>
        </label>
        <div class="row">
          <button :disabled="busy" @click="playSelectedFlow">Play flow</button>
          <button :disabled="busy" @click="playSelectedTc">Play test case</button>
          <button :disabled="busy || !recorded.length" @click="playRecorded">
            Play recorded
          </button>
          <button :disabled="busy" @click="stopAll">Stop</button>
        </div>
        <p class="muted tip">
          Templates like <code v-pre>{{faker.person.fullName()}}</code> expand
          before each loop.
        </p>
      </section>
    </template>
  </div>
</template>

<style>
:root {
  color-scheme: light;
  font-family: "Segoe UI", system-ui, sans-serif;
  font-size: 13px;
  color: #1a1a1a;
}
body {
  margin: 0;
  background: #f6f4ef;
}
.wrap {
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
h1 {
  margin: 0;
  font-size: 16px;
}
h2 {
  margin: 0 0 6px;
  font-size: 13px;
}
section {
  background: #fff;
  border: 1px solid #ddd6c8;
  border-radius: 8px;
  padding: 10px;
}
label {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-bottom: 6px;
}
input,
select,
button {
  font: inherit;
  padding: 6px 8px;
  border-radius: 6px;
  border: 1px solid #ccc;
}
button {
  background: #1f6feb;
  color: #fff;
  border-color: #1f6feb;
  cursor: pointer;
}
button.ghost {
  background: #fff;
  color: #333;
  border-color: #ccc;
}
button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 8px;
}
.muted {
  color: #666;
}
.err {
  color: #b00020;
}
.ok {
  margin: 0 0 8px;
  color: #0a7a32;
}
.steps {
  margin: 0;
  padding-left: 18px;
  max-height: 180px;
  overflow: auto;
}
.tip {
  margin: 8px 0 0;
  font-size: 11px;
}
code {
  background: #eee;
  padding: 1px 4px;
  border-radius: 3px;
}
</style>
