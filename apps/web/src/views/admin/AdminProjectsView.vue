<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from "vue";
import { message, Modal } from "ant-design-vue";
import { api } from "@/api/client";
import { API } from "@/api/endpoints";

type BaDbPublic = {
  configured: boolean;
  enabled: boolean;
  dialect: "mysql" | "postgres" | "mongodb" | null;
  host: string | null;
  port: number | null;
  database: string | null;
  username: string | null;
  ssl: boolean;
  updatedAt: string | null;
};

type BaProject = {
  id: string;
  slug: string;
  displayName: string;
  gitlabHost: string;
  gitlabPath: string;
  localPath: string;
  mainBranch: string | null;
  cloneStatus: string;
  cloneError: string | null;
  hasGitlabToken: boolean;
  db?: BaDbPublic;
};

const loading = ref(false);
const projects = ref<BaProject[]>([]);
const showForm = ref(false);
const editingId = ref<string | null>(null);
const wizardStep = ref(0);
const pollTimers = new Map<string, ReturnType<typeof setInterval>>();

const dbEditingId = ref<string | null>(null);
const dbSaving = ref(false);
const dbTesting = ref(false);
const dbForm = reactive({
  enabled: false,
  dialect: "mysql" as "mysql" | "postgres" | "mongodb",
  host: "",
  port: 3306,
  database: "",
  username: "",
  password: "",
  ssl: false,
});

const gitlabProjects = ref<
  Array<{ pathWithNamespace: string; name?: string; id?: number }>
>([]);
const branches = ref<string[]>([]);

const form = reactive({
  displayName: "",
  slug: "",
  gitlabPath: "",
  gitlabHost: "https://gitlab.com",
  gitlabToken: "",
  mainBranch: "main",
});

const steps = ["GitLab PAT", "Project", "Main branch"];

const projectOptions = computed(() =>
  gitlabProjects.value.map((p) => ({
    value: p.pathWithNamespace,
    label: p.pathWithNamespace,
  })),
);

const branchOptions = computed(() =>
  branches.value.map((b) => ({ value: b, label: b })),
);

const dbEditingProject = computed(() =>
  projects.value.find((p) => p.id === dbEditingId.value) || null,
);

function filterSelectOption(
  input: string,
  option?: { label?: string },
): boolean {
  return (option?.label || "").toLowerCase().includes(input.toLowerCase());
}

function resetForm() {
  editingId.value = null;
  wizardStep.value = 0;
  form.displayName = "";
  form.slug = "";
  form.gitlabPath = "";
  form.gitlabHost = "https://gitlab.com";
  form.gitlabToken = "";
  form.mainBranch = "main";
  gitlabProjects.value = [];
  branches.value = [];
}

function resetDbForm() {
  dbEditingId.value = null;
  dbForm.enabled = false;
  dbForm.dialect = "mysql";
  dbForm.host = "";
  dbForm.port = 3306;
  dbForm.database = "";
  dbForm.username = "";
  dbForm.password = "";
  dbForm.ssl = false;
}

async function load() {
  loading.value = true;
  try {
    const data = await api<{ projects?: BaProject[] }>(API.admin.baProjects);
    projects.value = data.projects || [];
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  } finally {
    loading.value = false;
  }
}

function openCreate() {
  resetForm();
  showForm.value = true;
}

function openEdit(p: BaProject) {
  resetForm();
  editingId.value = p.id;
  form.displayName = p.displayName;
  form.slug = p.slug;
  form.gitlabPath = p.gitlabPath;
  form.gitlabHost = p.gitlabHost || "https://gitlab.com";
  form.gitlabToken = "";
  form.mainBranch = p.mainBranch || "main";
  wizardStep.value = 0;
  showForm.value = true;
}

function openDb(p: BaProject) {
  dbEditingId.value = p.id;
  const d = p.db;
  dbForm.enabled = Boolean(d?.enabled);
  dbForm.dialect = d?.dialect || "mysql";
  dbForm.host = d?.host || "";
  dbForm.port =
    d?.port ||
    (d?.dialect === "postgres" ? 5432 : d?.dialect === "mongodb" ? 27017 : 3306);
  dbForm.database = d?.database || "";
  dbForm.username = d?.username || "";
  dbForm.password = "";
  dbForm.ssl = Boolean(d?.ssl);
}

function defaultPort(dialect: "mysql" | "postgres" | "mongodb") {
  if (dialect === "postgres") return 5432;
  if (dialect === "mongodb") return 27017;
  return 3306;
}

function onDialectChange(v: "mysql" | "postgres" | "mongodb") {
  dbForm.dialect = v;
  const known = [3306, 5432, 27017];
  if (!dbForm.port || known.includes(Number(dbForm.port))) {
    dbForm.port = defaultPort(v);
  }
}

async function loadPreviewProjects() {
  if (!form.gitlabToken.trim()) {
    message.warning("Enter GitLab PAT");
    return;
  }
  if (!form.gitlabHost.trim()) {
    message.warning("Enter GitLab host");
    return;
  }
  loading.value = true;
  try {
    const res = await api<{
      projects: Array<{
        pathWithNamespace: string;
        name?: string;
        id?: number;
      }>;
    }>("/api/gitlab/preview", {
      method: "POST",
      body: JSON.stringify({ gitlabToken: form.gitlabToken.trim() }),
    });
    gitlabProjects.value = res.projects || [];
    if (!gitlabProjects.value.length) {
      message.warning("PAT found no projects");
      return;
    }
    wizardStep.value = 1;
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  } finally {
    loading.value = false;
  }
}

function onProjectSelect(path: string) {
  form.gitlabPath = path;
  if (!form.displayName.trim()) {
    form.displayName = path.split("/").pop() || path;
  }
  if (!form.slug.trim() && !editingId.value) {
    form.slug = (path.split("/").pop() || path)
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-");
  }
}

async function loadBranchesForPath() {
  if (!form.gitlabPath.trim()) {
    message.warning("Select a GitLab project");
    return;
  }
  if (!form.displayName.trim()) {
    form.displayName =
      form.gitlabPath.trim().split("/").pop() || form.gitlabPath;
  }
  loading.value = true;
  try {
    const res = await api<{
      branches: Array<{ name: string; default?: boolean }>;
      defaultBranch?: string | null;
    }>("/api/gitlab/preview", {
      method: "POST",
      body: JSON.stringify({
        gitlabToken: form.gitlabToken.trim(),
        gitlabPath: form.gitlabPath.trim(),
      }),
    });
    branches.value = (res.branches || []).map((b) => b.name).filter(Boolean);
    form.mainBranch =
      res.defaultBranch ||
      branches.value.find((b) => b === "main" || b === "master") ||
      branches.value[0] ||
      form.mainBranch ||
      "main";
    wizardStep.value = 2;
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  } finally {
    loading.value = false;
  }
}

async function save() {
  if (!form.displayName.trim() || !form.gitlabPath.trim()) {
    message.warning("Display name and GitLab project required");
    return;
  }
  if (!form.mainBranch.trim()) {
    message.warning("Select main branch");
    return;
  }
  loading.value = true;
  try {
    const body: Record<string, string> = {
      displayName: form.displayName.trim(),
      gitlabPath: form.gitlabPath.trim(),
      gitlabHost: form.gitlabHost.trim() || "https://gitlab.com",
      mainBranch: form.mainBranch.trim() || "main",
    };
    if (form.slug.trim()) body.slug = form.slug.trim();
    if (form.gitlabToken.trim()) body.gitlabToken = form.gitlabToken.trim();

    if (editingId.value) {
      await api(API.admin.baProject(editingId.value), {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      message.success("Project updated");
    } else {
      if (!form.gitlabToken.trim()) {
        message.warning("GitLab PAT required for new projects");
        return;
      }
      await api(API.admin.baProjects, {
        method: "POST",
        body: JSON.stringify(body),
      });
      message.success("Project created");
    }
    showForm.value = false;
    resetForm();
    await load();
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  } finally {
    loading.value = false;
  }
}

async function saveDb() {
  if (!dbEditingId.value) return;
  if (!dbForm.host.trim() || !dbForm.database.trim()) {
    message.warning("Host and database required");
    return;
  }
  const isMongo = dbForm.dialect === "mongodb";
  if (!isMongo && !dbForm.username.trim()) {
    message.warning("Username required");
    return;
  }
  const existing = dbEditingProject.value?.db?.configured;
  if (!isMongo && !existing && !dbForm.password.trim()) {
    message.warning("Password required for first setup");
    return;
  }
  dbSaving.value = true;
  try {
    const db: Record<string, unknown> = {
      enabled: dbForm.enabled,
      dialect: dbForm.dialect,
      host: dbForm.host.trim(),
      port: Number(dbForm.port) || defaultPort(dbForm.dialect),
      database: dbForm.database.trim(),
      username: dbForm.username.trim(),
      ssl: dbForm.ssl,
    };
    if (dbForm.password.trim()) db.password = dbForm.password.trim();

    await api(API.admin.baProject(dbEditingId.value), {
      method: "PATCH",
      body: JSON.stringify({ db }),
    });
    message.success(
      dbForm.enabled
        ? "DB saved & active — BA chat can query read-only"
        : "DB saved (inactive)",
    );
    resetDbForm();
    await load();
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  } finally {
    dbSaving.value = false;
  }
}

async function testDb() {
  if (!dbEditingId.value) return;
  if (
    !dbEditingProject.value?.db?.configured &&
    dbForm.dialect !== "mongodb" &&
    !dbForm.password.trim()
  ) {
    message.warning("Save DB credentials first, then test");
    return;
  }
  if (!dbForm.host.trim() || !dbForm.database.trim()) {
    message.warning("Host and database required");
    return;
  }
  // Save latest form (except blank password keeps old) then test
  dbTesting.value = true;
  try {
    const isMongo = dbForm.dialect === "mongodb";
    const canSave =
      dbForm.host.trim() &&
      dbForm.database.trim() &&
      (isMongo ||
        dbForm.username.trim()) &&
      (isMongo ||
        dbEditingProject.value?.db?.configured ||
        dbForm.password.trim());
    if (canSave) {
      const db: Record<string, unknown> = {
        enabled: dbForm.enabled,
        dialect: dbForm.dialect,
        host: dbForm.host.trim(),
        port: Number(dbForm.port) || defaultPort(dbForm.dialect),
        database: dbForm.database.trim(),
        username: dbForm.username.trim(),
        ssl: dbForm.ssl,
      };
      if (dbForm.password.trim()) db.password = dbForm.password.trim();
      await api(API.admin.baProject(dbEditingId.value), {
        method: "PATCH",
        body: JSON.stringify({ db }),
      });
      await load();
    }
    const res = await api<{ ok?: boolean; elapsedMs?: number; dialect?: string }>(
      API.admin.baTestDb(dbEditingId.value),
      { method: "POST", body: "{}" },
    );
    message.success(
      `Connection OK (${res.dialect || dbForm.dialect}, ${res.elapsedMs ?? "?"}ms)`,
    );
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  } finally {
    dbTesting.value = false;
  }
}

function clearDb() {
  if (!dbEditingId.value) return;
  Modal.confirm({
    title: "Remove DB connection?",
    content: "Encrypted credentials will be deleted. BA chat cannot query DB.",
    okType: "danger",
    onOk: async () => {
      await api(API.admin.baProject(dbEditingId.value!), {
        method: "PATCH",
        body: JSON.stringify({ db: { clear: true } }),
      });
      message.success("DB connection removed");
      resetDbForm();
      await load();
    },
  });
}

function confirmDelete(p: BaProject) {
  Modal.confirm({
    title: `Delete ${p.displayName}?`,
    content: "BA users will no longer see this project.",
    okType: "danger",
    onOk: async () => {
      await api(API.admin.baProject(p.id), { method: "DELETE" });
      message.success("Deleted");
      await load();
    },
  });
}

function stopPoll(id: string) {
  const t = pollTimers.get(id);
  if (t) {
    clearInterval(t);
    pollTimers.delete(id);
  }
}

function startPoll(id: string) {
  stopPoll(id);
  const t = setInterval(async () => {
    try {
      const data = await api<{
        project?: BaProject;
        ready?: boolean;
      }>(API.admin.baCloneStatus(id));
      const status = data.project?.cloneStatus;
      if (status === "ready" || status === "failed") {
        stopPoll(id);
        await load();
        if (status === "ready") message.success("Clone ready");
        if (status === "failed") {
          message.error(data.project?.cloneError || "Clone failed");
        }
      } else {
        const idx = projects.value.findIndex((x) => x.id === id);
        if (idx >= 0 && data.project) {
          projects.value[idx] = data.project;
        }
      }
    } catch {
      stopPoll(id);
    }
  }, 2000);
  pollTimers.set(id, t);
}

function confirmClone(p: BaProject) {
  Modal.confirm({
    title: `Clone ${p.displayName}?`,
    content: `Into ${p.localPath}`,
    onOk: async () => {
      loading.value = true;
      try {
        await api(API.admin.baClone(p.id), {
          method: "POST",
          body: JSON.stringify({ confirm: true }),
        });
        message.info("Cloning…");
        startPoll(p.id);
        await load();
      } catch (e) {
        message.error(e instanceof Error ? e.message : String(e));
      } finally {
        loading.value = false;
      }
    },
  });
}

function dbBadge(p: BaProject) {
  if (!p.db?.configured) return { label: "DB: none", cls: "text-ink-muted" };
  if (p.db.enabled)
    return { label: `DB: ON (${p.db.dialect})`, cls: "text-green-600" };
  return { label: `DB: off (${p.db.dialect})`, cls: "text-orange-600" };
}

onMounted(() => {
  void load();
});

onUnmounted(() => {
  for (const id of pollTimers.keys()) stopPoll(id);
});
</script>

<template>
  <div class="max-w-4xl mx-auto px-4 py-6">
    <div class="flex items-center justify-between gap-4 mb-6">
      <div>
        <h1 class="text-xl font-semibold text-ink m-0">BA projects</h1>
        <p class="text-sm text-ink-muted mt-1 mb-0">
          Wizard: GitLab host + PAT → chọn project → main branch · clone vào
          <code class="text-xs">project/_ba/&lt;slug&gt;/source</code>
          · DB (tuỳ chọn) bật mới cho BA tra cứu read-only
        </p>
      </div>
      <button
        type="button"
        class="faw-btn faw-btn--run"
        :disabled="loading"
        @click="openCreate"
      >
        New project
      </button>
    </div>

    <div
      v-if="showForm"
      class="mb-6 p-4 rounded-lg border border-line bg-surface-raised shadow-sm"
    >
      <h2 class="text-base font-semibold text-ink mt-0 mb-3">
        {{ editingId ? "Edit project" : "Create project" }}
      </h2>

      <div class="flex gap-2 mb-4 flex-wrap">
        <span
          v-for="(s, i) in steps"
          :key="s"
          class="px-2.5 py-1 rounded text-xs border"
          :class="
            wizardStep === i
              ? 'border-accent text-accent bg-accent-soft font-semibold'
              : wizardStep > i
                ? 'border-line text-ink'
                : 'border-line text-ink-muted'
          "
        >
          {{ i + 1 }}. {{ s }}
        </span>
      </div>

      <div v-if="wizardStep === 0" class="space-y-3">
        <label class="flex flex-col gap-1 text-sm">
          <span class="text-ink-muted">GitLab host</span>
          <a-input
            v-model:value="form.gitlabHost"
            placeholder="https://gitlab.com"
          />
        </label>
        <label class="flex flex-col gap-1 text-sm">
          <span class="text-ink-muted">
            GitLab PAT
            {{ editingId ? "(bắt buộc để load lại list project)" : "" }}
          </span>
          <a-input-password
            v-model:value="form.gitlabToken"
            placeholder="glpat-…"
          />
        </label>
        <div class="flex gap-2 pt-1">
          <button
            type="button"
            class="faw-btn faw-btn--run"
            :disabled="loading"
            @click="loadPreviewProjects"
          >
            {{ loading ? "Loading…" : "Continue" }}
          </button>
          <button
            type="button"
            class="px-3 py-1.5 text-sm text-ink-muted hover:text-ink"
            @click="showForm = false"
          >
            Cancel
          </button>
        </div>
      </div>

      <div v-else-if="wizardStep === 1" class="space-y-3">
        <label class="flex flex-col gap-1 text-sm">
          <span class="text-ink-muted">GitLab project</span>
          <a-select
            :value="form.gitlabPath || undefined"
            show-search
            :options="projectOptions"
            placeholder="Select project"
            class="w-full"
            :filter-option="filterSelectOption"
            @update:value="onProjectSelect"
          />
        </label>
        <label class="flex flex-col gap-1 text-sm">
          <span class="text-ink-muted">Display name</span>
          <a-input v-model:value="form.displayName" placeholder="YKK" />
        </label>
        <label v-if="!editingId" class="flex flex-col gap-1 text-sm">
          <span class="text-ink-muted">Slug <em>(optional)</em></span>
          <a-input v-model:value="form.slug" placeholder="ykk" />
        </label>
        <div class="flex gap-2 pt-1">
          <button
            type="button"
            class="px-3 py-1.5 text-sm border border-line rounded-md"
            @click="wizardStep = 0"
          >
            Back
          </button>
          <button
            type="button"
            class="faw-btn faw-btn--run"
            :disabled="loading"
            @click="loadBranchesForPath"
          >
            {{ loading ? "Loading…" : "Continue" }}
          </button>
        </div>
      </div>

      <div v-else class="space-y-3">
        <label class="flex flex-col gap-1 text-sm">
          <span class="text-ink-muted">Main branch</span>
          <a-select
            v-model:value="form.mainBranch"
            show-search
            :options="branchOptions"
            placeholder="Select branch"
            class="w-full"
            :filter-option="filterSelectOption"
          />
        </label>
        <p class="text-xs text-ink-muted m-0">
          {{ form.gitlabPath }} · {{ form.displayName }}
        </p>
        <div class="flex gap-2 pt-1">
          <button
            type="button"
            class="px-3 py-1.5 text-sm border border-line rounded-md"
            @click="wizardStep = 1"
          >
            Back
          </button>
          <button
            type="button"
            class="faw-btn faw-btn--run"
            :disabled="loading"
            @click="save"
          >
            {{ loading ? "Saving…" : editingId ? "Save" : "Create" }}
          </button>
        </div>
      </div>
    </div>

    <div
      v-if="dbEditingId"
      class="mb-6 p-4 rounded-lg border border-line bg-surface-raised shadow-sm"
    >
      <h2 class="text-base font-semibold text-ink mt-0 mb-1">
        Database — {{ dbEditingProject?.displayName || dbEditingId }}
      </h2>
      <p class="text-xs text-ink-muted mt-0 mb-3">
        Password được mã hoá AES-GCM (FLOW_SECRETS_KEY). Chỉ khi
        <strong class="text-ink font-medium">Active</strong> BA chat mới được
        query read-only qua tool an toàn — không lộ credential vào agent shell.
      </p>
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label class="flex flex-col gap-1 text-sm sm:col-span-2">
          <span class="text-ink-muted">Active (cho phép BA tra DB)</span>
          <a-switch v-model:checked="dbForm.enabled" />
        </label>
        <label class="flex flex-col gap-1 text-sm">
          <span class="text-ink-muted">Dialect</span>
          <a-select
            :value="dbForm.dialect"
            :options="[
              { value: 'mysql', label: 'MySQL / MariaDB' },
              { value: 'postgres', label: 'PostgreSQL' },
              { value: 'mongodb', label: 'MongoDB' },
            ]"
            class="w-full"
            @update:value="onDialectChange"
          />
        </label>
        <label class="flex flex-col gap-1 text-sm">
          <span class="text-ink-muted">Port</span>
          <a-input-number v-model:value="dbForm.port" class="w-full" :min="1" />
        </label>
        <label class="flex flex-col gap-1 text-sm sm:col-span-2">
          <span class="text-ink-muted">Host</span>
          <a-input v-model:value="dbForm.host" placeholder="db.example.com" />
        </label>
        <label class="flex flex-col gap-1 text-sm">
          <span class="text-ink-muted">Database</span>
          <a-input v-model:value="dbForm.database" placeholder="app_db" />
        </label>
        <label class="flex flex-col gap-1 text-sm">
          <span class="text-ink-muted">
            Username
            <em v-if="dbForm.dialect === 'mongodb'">(optional if no auth)</em>
          </span>
          <a-input v-model:value="dbForm.username" placeholder="readonly_user" />
        </label>
        <label class="flex flex-col gap-1 text-sm sm:col-span-2">
          <span class="text-ink-muted">
            Password
            <template v-if="dbForm.dialect === 'mongodb'">
              (optional if no auth
              {{
                dbEditingProject?.db?.configured ? "; blank = keep old" : ""
              }})
            </template>
            <template v-else-if="dbEditingProject?.db?.configured">
              (để trống = giữ password cũ)
            </template>
          </span>
          <a-input-password
            v-model:value="dbForm.password"
            placeholder="••••••••"
          />
        </label>
        <label class="flex items-center gap-2 text-sm sm:col-span-2">
          <a-checkbox v-model:checked="dbForm.ssl" />
          <span class="text-ink-muted">Use SSL</span>
        </label>
      </div>
      <div class="flex flex-wrap gap-2 pt-4">
        <button
          type="button"
          class="faw-btn faw-btn--run"
          :disabled="dbSaving"
          @click="saveDb"
        >
          {{ dbSaving ? "Saving…" : "Save DB" }}
        </button>
        <button
          type="button"
          class="px-3 py-1.5 text-sm border border-line rounded-md hover:border-accent"
          :disabled="dbTesting"
          @click="testDb"
        >
          {{ dbTesting ? "Testing…" : "Test connection" }}
        </button>
        <button
          v-if="dbEditingProject?.db?.configured"
          type="button"
          class="px-3 py-1.5 text-sm text-red-600 border border-line rounded-md"
          @click="clearDb"
        >
          Remove DB
        </button>
        <button
          type="button"
          class="px-3 py-1.5 text-sm text-ink-muted hover:text-ink"
          @click="resetDbForm"
        >
          Cancel
        </button>
      </div>
    </div>

    <a-spin :spinning="loading && !showForm && !dbEditingId">
      <div v-if="!projects.length" class="text-center py-16 text-ink-muted">
        <p class="mb-3">No BA projects yet.</p>
        <button type="button" class="faw-btn faw-btn--run" @click="openCreate">
          Create first project
        </button>
      </div>
      <ul v-else class="list-none m-0 p-0 flex flex-col gap-3">
        <li
          v-for="p in projects"
          :key="p.id"
          class="p-4 rounded-lg border border-line bg-surface-raised"
        >
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div class="min-w-0">
              <div class="font-semibold text-ink">{{ p.displayName }}</div>
              <div class="text-sm text-ink-muted mt-0.5">
                {{ p.gitlabPath }} · {{ p.mainBranch || "—" }} · {{ p.slug }}
              </div>
              <div class="text-xs text-ink-muted mt-1 font-mono truncate">
                {{ p.localPath }}
              </div>
              <div class="mt-2 flex items-center gap-2 text-xs flex-wrap">
                <span
                  class="px-2 py-0.5 rounded"
                  :class="{
                    'bg-gray-100 text-gray-700': p.cloneStatus === 'pending',
                    'bg-blue-50 text-blue-700': p.cloneStatus === 'cloning',
                    'bg-green-50 text-green-700': p.cloneStatus === 'ready',
                    'bg-red-50 text-red-700': p.cloneStatus === 'failed',
                  }"
                >
                  {{ p.cloneStatus }}
                </span>
                <span :class="dbBadge(p).cls">{{ dbBadge(p).label }}</span>
                <span v-if="!p.hasGitlabToken" class="text-orange-600">
                  No PAT
                </span>
                <span v-if="p.cloneError" class="text-red-600 truncate max-w-md">
                  {{ p.cloneError }}
                </span>
              </div>
            </div>
            <div class="flex flex-wrap gap-2">
              <button
                type="button"
                class="px-3 py-1.5 text-sm border border-line rounded-md hover:border-accent"
                @click="openEdit(p)"
              >
                Edit
              </button>
              <button
                type="button"
                class="px-3 py-1.5 text-sm border border-line rounded-md hover:border-accent"
                @click="openDb(p)"
              >
                Database
              </button>
              <a-tooltip
                :title="
                  !p.hasGitlabToken
                    ? 'Add a GitLab PAT first'
                    : p.cloneStatus === 'cloning'
                      ? 'Clone in progress'
                      : 'Clone repository'
                "
              >
                <button
                  type="button"
                  class="px-3 py-1.5 text-sm border border-line rounded-md hover:border-accent disabled:opacity-50"
                  :disabled="!p.hasGitlabToken || p.cloneStatus === 'cloning'"
                  @click="confirmClone(p)"
                >
                  Clone
                </button>
              </a-tooltip>
              <button
                type="button"
                class="px-3 py-1.5 text-sm text-red-600 border border-line rounded-md hover:border-red-400"
                @click="confirmDelete(p)"
              >
                Delete
              </button>
            </div>
          </div>
        </li>
      </ul>
    </a-spin>
  </div>
</template>
