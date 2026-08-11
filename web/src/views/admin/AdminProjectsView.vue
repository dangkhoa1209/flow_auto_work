<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from "vue";
import { message, Modal } from "ant-design-vue";
import { api } from "@/api/client";
import { API } from "@/api/endpoints";

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
};

const loading = ref(false);
const projects = ref<BaProject[]>([]);
const showForm = ref(false);
const editingId = ref<string | null>(null);
const wizardStep = ref(0);
const pollTimers = new Map<string, ReturnType<typeof setInterval>>();

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

      <!-- Step 0: Host + PAT -->
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

      <!-- Step 1: Select project -->
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

      <!-- Step 2: Main branch -->
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

    <a-spin :spinning="loading && !showForm">
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
              <div class="mt-2 flex items-center gap-2 text-xs">
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
