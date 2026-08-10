<script setup lang="ts">
import { onMounted, onUnmounted, reactive, ref } from "vue";
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
const pollTimers = new Map<string, ReturnType<typeof setInterval>>();

const form = reactive({
  displayName: "",
  slug: "",
  gitlabPath: "",
  gitlabHost: "https://gitlab.com",
  gitlabToken: "",
  mainBranch: "main",
});

function resetForm() {
  editingId.value = null;
  form.displayName = "";
  form.slug = "";
  form.gitlabPath = "";
  form.gitlabHost = "https://gitlab.com";
  form.gitlabToken = "";
  form.mainBranch = "main";
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
  editingId.value = p.id;
  form.displayName = p.displayName;
  form.slug = p.slug;
  form.gitlabPath = p.gitlabPath;
  form.gitlabHost = p.gitlabHost;
  form.gitlabToken = "";
  form.mainBranch = p.mainBranch || "main";
  showForm.value = true;
}

async function save() {
  if (!form.displayName.trim() || !form.gitlabPath.trim()) {
    message.warning("Display name and GitLab path required");
    return;
  }
  loading.value = true;
  try {
    const body: Record<string, string> = {
      displayName: form.displayName.trim(),
      gitlabPath: form.gitlabPath.trim(),
      gitlabHost: form.gitlabHost.trim(),
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
          Shared sources for BA / PD / QC chat. Enter GitLab PAT per project to clone.
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
      <h2 class="text-base font-semibold text-ink mt-0 mb-4">
        {{ editingId ? "Edit project" : "Create project" }}
      </h2>
      <div class="grid gap-3 sm:grid-cols-2">
        <label class="flex flex-col gap-1 text-sm">
          <span class="text-ink-muted">Display name</span>
          <a-input v-model:value="form.displayName" placeholder="YKK" />
        </label>
        <label class="flex flex-col gap-1 text-sm">
          <span class="text-ink-muted">Slug <em>(optional)</em></span>
          <a-input
            v-model:value="form.slug"
            placeholder="ykk"
            :disabled="Boolean(editingId)"
          />
        </label>
        <label class="flex flex-col gap-1 text-sm sm:col-span-2">
          <span class="text-ink-muted">GitLab path</span>
          <a-input
            v-model:value="form.gitlabPath"
            placeholder="group/repo"
          />
        </label>
        <label class="flex flex-col gap-1 text-sm">
          <span class="text-ink-muted">GitLab host</span>
          <a-input v-model:value="form.gitlabHost" />
        </label>
        <label class="flex flex-col gap-1 text-sm">
          <span class="text-ink-muted">Main branch</span>
          <a-input v-model:value="form.mainBranch" />
        </label>
        <label class="flex flex-col gap-1 text-sm sm:col-span-2">
          <span class="text-ink-muted">
            GitLab PAT {{ editingId ? "(leave blank to keep)" : "" }}
          </span>
          <a-input-password
            v-model:value="form.gitlabToken"
            placeholder="glpat-…"
          />
        </label>
      </div>
      <div class="flex gap-2 mt-4">
        <button
          type="button"
          class="faw-btn faw-btn--run"
          :disabled="loading"
          @click="save"
        >
          {{ loading ? "Saving…" : "Save" }}
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
                {{ p.gitlabPath }} · {{ p.slug }}
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
