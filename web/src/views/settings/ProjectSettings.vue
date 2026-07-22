<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { message } from "ant-design-vue";
import { FolderOpenOutlined } from "@ant-design/icons-vue";
import { api } from "@/api/client";
import { useSessionStore } from "@/stores/session";
import FolderPicker from "@/components/FolderPicker.vue";

const session = useSessionStore();
const loading = ref(false);
const folderOpen = ref(false);
const projects = ref<Array<{ path_with_namespace: string }>>([]);
const branches = ref<string[]>([]);

const form = reactive({
  projectId: session.session.projectId || "",
  gitlabPath: "",
  repoPath: "",
  baseBranch: "",
  workBranch: "",
});

const current = computed(() => session.currentMembership);

function syncFromCurrent() {
  const m = current.value;
  if (!m) return;
  form.projectId = m.projectId;
  form.gitlabPath = m.project.gitlabPath;
  form.repoPath = m.project.repoPath || "";
  form.baseBranch = m.baseBranch || "";
  form.workBranch = m.workBranch || "";
}

onMounted(async () => {
  syncFromCurrent();
  try {
    const proj = await api<{
      projects: Array<{ pathWithNamespace: string; name?: string }>;
    }>("/api/gitlab/my-projects");
    projects.value = (proj.projects || []).map((p) => ({
      path_with_namespace: p.pathWithNamespace,
    }));
  } catch {
    /* ignore */
  }
  if (form.gitlabPath && form.repoPath) await loadBranches();
});

async function loadBranches() {
  if (!form.gitlabPath) return;
  try {
    const qs = new URLSearchParams({ gitlabPath: form.gitlabPath });
    if (form.repoPath.trim()) qs.set("repoPath", form.repoPath.trim());
    const br = await api<{
      remote?: Array<{ name: string; default?: boolean }>;
      local?: string[];
      defaultBranch?: string | null;
    }>(`/api/gitlab/branches?${qs.toString()}`);
    const names = new Set<string>();
    for (const b of br.remote || []) {
      if (b.name) names.add(b.name);
    }
    for (const b of br.local || []) {
      if (b) names.add(b);
    }
    branches.value = Array.from(names).sort((a, b) => a.localeCompare(b));
    if (!form.baseBranch) {
      form.baseBranch =
        br.defaultBranch ||
        branches.value.find((b) => b === "main" || b === "master") ||
        branches.value[0] ||
        "";
    }
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  }
}

async function switchProject() {
  if (!form.projectId) return;
  session.setSession({ projectId: form.projectId });
  await session.refreshMe();
  syncFromCurrent();
  message.success("Đã chuyển project");
}

async function saveBranches() {
  if (!session.session.projectId) return;
  loading.value = true;
  try {
    await api(`/api/me/projects/${encodeURIComponent(session.session.projectId)}`, {
      method: "PUT",
      body: JSON.stringify({
        baseBranch: form.baseBranch || "",
        workBranch: form.workBranch || "",
        repoPath: form.repoPath || undefined,
      }),
    });
    await session.refreshMe();
    message.success("Đã lưu nhánh");
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  } finally {
    loading.value = false;
  }
}

async function joinProject() {
  if (!form.gitlabPath || !form.repoPath) {
    message.warning("Cần gitlab path + local path");
    return;
  }
  loading.value = true;
  try {
    const res = await api<{ project: { id: string } }>("/api/projects/join", {
      method: "POST",
      body: JSON.stringify({
        gitlabPath: form.gitlabPath,
        repoPath: form.repoPath,
        baseBranch: form.baseBranch || undefined,
        workBranch: form.workBranch || undefined,
      }),
    });
    session.setSession({ projectId: res.project.id });
    await session.refreshMe();
    syncFromCurrent();
    message.success("Đã join project");
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="space-y-5">
    <div>
      <h2 class="text-lg font-medium m-0 mb-3">Project hiện tại</h2>
      <a-form layout="vertical">
        <a-form-item label="Switch project">
          <div class="flex gap-2">
            <a-select
              v-model:value="form.projectId"
              class="flex-1"
              :options="
                session.memberships.map((m) => ({
                  value: m.projectId,
                  label: m.project.displayName || m.project.gitlabPath,
                }))
              "
            />
            <a-button @click="switchProject">Switch</a-button>
          </div>
        </a-form-item>
        <a-form-item label="Local repo path">
          <div class="flex gap-2">
            <a-input v-model:value="form.repoPath" class="flex-1" />
            <a-button @click="folderOpen = true">
              <template #icon><FolderOpenOutlined /></template>
              Chọn
            </a-button>
          </div>
        </a-form-item>
        <a-form-item label="Base branch">
          <a-select
            v-model:value="form.baseBranch"
            show-search
            allow-clear
            class="w-full"
            :options="branches.map((b) => ({ value: b, label: b }))"
            @focus="loadBranches"
          />
        </a-form-item>
        <a-form-item label="Work branch (optional)">
          <a-input v-model:value="form.workBranch" placeholder="feat/…" />
        </a-form-item>
        <a-button type="primary" :loading="loading" @click="saveBranches"
          >Lưu nhánh / path</a-button
        >
      </a-form>
    </div>

    <a-divider />

    <div>
      <h2 class="text-lg font-medium m-0 mb-3">Join project khác</h2>
      <a-form layout="vertical">
        <a-form-item label="GitLab path">
          <a-select
            v-model:value="form.gitlabPath"
            show-search
            class="w-full"
            :options="
              projects.map((p) => ({
                value: p.path_with_namespace,
                label: p.path_with_namespace,
              }))
            "
            @change="loadBranches"
          />
        </a-form-item>
        <a-form-item label="Local path">
          <div class="flex gap-2">
            <a-input v-model:value="form.repoPath" class="flex-1" />
            <a-button @click="folderOpen = true">
              <template #icon><FolderOpenOutlined /></template>
              Chọn
            </a-button>
          </div>
        </a-form-item>
        <a-button :loading="loading" @click="joinProject">Join</a-button>
      </a-form>
    </div>

    <FolderPicker v-model:open="folderOpen" v-model="form.repoPath" />
  </div>
</template>
