<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from "vue";
import { message, Modal } from "ant-design-vue";
import { api } from "@/api/client";
import { useSessionStore } from "@/stores/session";

const session = useSessionStore();
const loading = ref(false);
const cloningId = ref<string | null>(null);
const pollTimer = ref<ReturnType<typeof setInterval> | null>(null);

const wizardOpen = ref(false);
const wizardStep = ref(0);
const editId = ref<string | null>(null);

type ProjectPublic = {
  id: string;
  projectName?: string;
  displayName?: string;
  gitlabPath: string;
  gitlabHost?: string;
  localPath?: string;
  repoPath?: string;
  mainBranch?: string | null;
  workingBranch?: string | null;
  isActive?: boolean;
  cloneStatus?: string;
  cloneError?: string | null;
  hasGitlabToken?: boolean;
};

const form = reactive({
  gitlabHost: "https://gitlab.com",
  gitlabToken: "",
  gitlabPath: "",
  projectName: "",
  displayName: "",
  mainBranch: "main",
  workingBranch: "",
  localPath: "",
});

const gitlabProjects = ref<
  Array<{ pathWithNamespace: string; name?: string; id?: number }>
>([]);
const branches = ref<string[]>([]);
const previewDefaultPath = ref("");

const steps = [
  "GitLab PAT",
  "Dự án",
  "Nhánh chính",
  "Nhánh làm việc",
  "Local path",
];

const tableRows = computed(() =>
  session.memberships.map((m) => {
    const p = m.project as ProjectPublic;
    return {
      key: m.projectId,
      id: m.projectId,
      name: p.displayName || p.projectName || p.gitlabPath,
      gitlabPath: p.gitlabPath,
      mainBranch: p.mainBranch || m.baseBranch || "—",
      workBranch: p.workingBranch || m.workBranch || "—",
      localPath: p.localPath || p.repoPath || "—",
      cloneStatus: p.cloneStatus || "—",
      cloneError: p.cloneError,
      isActive: Boolean(p.isActive),
      hasToken: Boolean(p.hasGitlabToken),
    };
  }),
);

const columns = [
  { title: "Tên", dataIndex: "name", key: "name", ellipsis: true },
  { title: "GitLab", dataIndex: "gitlabPath", key: "gitlabPath", ellipsis: true },
  { title: "Main", dataIndex: "mainBranch", key: "mainBranch", width: 100 },
  { title: "Work", dataIndex: "workBranch", key: "workBranch", width: 120 },
  { title: "Path", dataIndex: "localPath", key: "localPath", ellipsis: true },
  { title: "Clone", dataIndex: "cloneStatus", key: "cloneStatus", width: 100 },
  { title: "Active", key: "active", width: 80 },
  { title: "", key: "actions", width: 220 },
];

onUnmounted(() => {
  if (pollTimer.value) clearInterval(pollTimer.value);
});

watch(
  () => [form.projectName, form.gitlabPath] as const,
  async ([name, path]) => {
    const slug =
      name.trim() ||
      path.trim().split("/").pop() ||
      "project";
    try {
      const res = await api<{ localPath: string }>(
        `/api/projects/default-path?projectName=${encodeURIComponent(slug)}`,
      );
      previewDefaultPath.value = res.localPath;
    } catch {
      previewDefaultPath.value = "";
    }
  },
);

function resetWizard() {
  wizardStep.value = 0;
  editId.value = null;
  form.gitlabHost = "https://gitlab.com";
  form.gitlabToken = "";
  form.gitlabPath = "";
  form.projectName = "";
  form.displayName = "";
  form.mainBranch = "main";
  form.workingBranch = "";
  form.localPath = "";
  gitlabProjects.value = [];
  branches.value = [];
}

function openCreate() {
  resetWizard();
  wizardOpen.value = true;
}

function openEdit(row: (typeof tableRows.value)[0]) {
  resetWizard();
  editId.value = row.id;
  const m = session.memberships.find((x) => x.projectId === row.id);
  const p = m?.project as ProjectPublic | undefined;
  form.gitlabHost = p?.gitlabHost || "https://gitlab.com";
  form.gitlabPath = p?.gitlabPath || row.gitlabPath;
  form.projectName = p?.projectName || row.name;
  form.displayName = p?.displayName || row.name;
  form.mainBranch =
    (p?.mainBranch || m?.baseBranch || "main") as string;
  form.workingBranch =
    (p?.workingBranch || m?.workBranch || "") as string;
  form.localPath = (p?.localPath || p?.repoPath || "") as string;
  form.gitlabToken = "";
  wizardStep.value = 0;
  wizardOpen.value = true;
}

async function loadPreviewProjects() {
  if (!form.gitlabToken.trim()) {
    message.warning("Nhập GitLab PAT");
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
      message.warning("PAT không thấy project nào");
      return;
    }
    wizardStep.value = 1;
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  } finally {
    loading.value = false;
  }
}

async function loadBranchesForPath() {
  if (!form.gitlabPath.trim()) {
    message.warning("Chọn dự án GitLab");
    return;
  }
  if (!form.projectName.trim()) {
    form.projectName =
      form.gitlabPath.trim().split("/").pop() || form.gitlabPath;
  }
  loading.value = true;
  try {
    if (form.gitlabToken.trim()) {
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
      if (!form.mainBranch || form.mainBranch === "main") {
        form.mainBranch =
          res.defaultBranch ||
          branches.value.find((b) => b === "main" || b === "master") ||
          branches.value[0] ||
          "main";
      }
    }
    wizardStep.value = 2;
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  } finally {
    loading.value = false;
  }
}

function nextFromMain() {
  if (!form.mainBranch.trim()) {
    message.warning("Chọn nhánh chính");
    return;
  }
  wizardStep.value = 3;
}

function nextFromWork() {
  wizardStep.value = 4;
}

async function pollClone(projectId: string) {
  if (pollTimer.value) clearInterval(pollTimer.value);
  cloningId.value = projectId;
  pollTimer.value = setInterval(async () => {
    try {
      const st = await api<{ project?: ProjectPublic }>(
        `/api/projects/${encodeURIComponent(projectId)}/clone-status`,
      );
      const status = st.project?.cloneStatus;
      if (status === "ready") {
        cloningId.value = null;
        if (pollTimer.value) clearInterval(pollTimer.value);
        await session.refreshMe();
        message.success(
          `Clone xong → ${st.project?.localPath || st.project?.repoPath || ""}`,
        );
      } else if (status === "failed") {
        cloningId.value = null;
        if (pollTimer.value) clearInterval(pollTimer.value);
        await session.refreshMe();
        message.error(st.project?.cloneError || "Clone failed");
      }
    } catch {
      /* keep polling */
    }
  }, 2000);
}

async function startClone(
  projectId: string,
  opts?: { localPath?: string; silentConfirm?: boolean },
) {
  const m = session.memberships.find((x) => x.projectId === projectId);
  const p = m?.project as ProjectPublic | undefined;
  const localPath =
    opts?.localPath || p?.localPath || p?.repoPath || previewDefaultPath.value;
  const gitlabPath = p?.gitlabPath || form.gitlabPath;
  if (!localPath || !gitlabPath) {
    message.warning("Thiếu path hoặc gitlab path");
    return;
  }

  if (!opts?.silentConfirm) {
    const ok = await new Promise<boolean>((resolve) => {
      Modal.confirm({
        title: "Clone source?",
        content: `Sẽ clone vào:\n${localPath}`,
        okText: "Clone",
        cancelText: "Hủy",
        onOk: () => resolve(true),
        onCancel: () => resolve(false),
      });
    });
    if (!ok) return;
  }

  cloningId.value = projectId;
  try {
    await api(`/api/projects/${encodeURIComponent(projectId)}/clone`, {
      method: "POST",
      body: JSON.stringify({
        confirm: true,
        gitlabToken: form.gitlabToken || undefined,
        localPath: opts?.localPath || undefined,
      }),
    });
    message.info(`Đang clone source vào thư mục:\n${localPath}`);
    await pollClone(projectId);
  } catch (e) {
    cloningId.value = null;
    message.error(e instanceof Error ? e.message : String(e));
  }
}

async function saveWizard() {
  loading.value = true;
  try {
    const pathEmpty = !form.localPath.trim();
    const resolvedPath = pathEmpty
      ? previewDefaultPath.value
      : form.localPath.trim();

    if (editId.value) {
      await api(`/api/me/projects/${encodeURIComponent(editId.value)}`, {
        method: "PUT",
        body: JSON.stringify({
          baseBranch: form.mainBranch || "",
          workBranch: form.workingBranch || "",
          localPath: resolvedPath || undefined,
          gitlabToken: form.gitlabToken || undefined,
          gitlabHost: form.gitlabHost || undefined,
          gitlabPath: form.gitlabPath || undefined,
        }),
      });
      await session.refreshMe();
      wizardOpen.value = false;
      if (pathEmpty && resolvedPath) {
        message.success(
          `Đã lưu. Path trống → dùng thư mục mặc định:\n${resolvedPath}`,
        );
        await startClone(editId.value, {
          localPath: resolvedPath,
          silentConfirm: true,
        });
      } else {
        message.success("Đã cập nhật project");
      }
      return;
    }

    if (!form.gitlabToken.trim()) {
      message.warning("Cần GitLab PAT");
      return;
    }
    if (!form.gitlabPath.trim() || !form.projectName.trim()) {
      message.warning("Thiếu dự án / tên project");
      return;
    }

    const res = await api<{
      project: ProjectPublic;
      memberships?: typeof session.memberships;
      defaultLocalPath?: string;
      usedDefaultPath?: boolean;
    }>("/api/projects", {
      method: "POST",
      body: JSON.stringify({
        projectName: form.projectName.trim(),
        gitlabPath: form.gitlabPath.trim(),
        gitlabHost: form.gitlabHost || "https://gitlab.com",
        gitlabToken: form.gitlabToken,
        localPath: pathEmpty ? undefined : form.localPath.trim(),
        mainBranch: form.mainBranch || undefined,
        workingBranch: form.workingBranch || undefined,
        displayName: form.displayName || form.projectName,
        activate: true,
      }),
    });

    session.setMemberships(res.memberships);
    session.setSession({ projectId: res.project.id });
    await session.refreshMe();
    wizardOpen.value = false;

    const clonePath =
      res.project.localPath || res.defaultLocalPath || resolvedPath;
    if (res.usedDefaultPath || pathEmpty) {
      message.success(
        `Đã tạo project. Path trống → clone vào thư mục mặc định:\n${clonePath}`,
        6,
      );
    } else {
      message.success(`Đã tạo project. Clone vào:\n${clonePath}`, 5);
    }

    await startClone(res.project.id, {
      localPath: clonePath,
      silentConfirm: true,
    });
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  } finally {
    loading.value = false;
  }
}

async function activate(id: string) {
  loading.value = true;
  try {
    await session.activateProject(id);
    message.success("Đã kích hoạt project");
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  } finally {
    loading.value = false;
  }
}

async function remove(id: string) {
  Modal.confirm({
    title: "Xóa project?",
    content: "Chỉ xóa metadata trong Flow (không xóa folder local).",
    okType: "danger",
    onOk: async () => {
      await api(`/api/projects/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      await session.refreshMe();
      if (session.session.projectId === id) {
        const next = session.memberships[0]?.projectId || null;
        session.setSession({ projectId: next });
      }
      message.success("Đã xóa project");
    },
  });
}

onMounted(async () => {
  await session.refreshMe().catch(() => undefined);
});
</script>

<template>
  <div class="space-y-4">
    <div class="flex items-center justify-between gap-3">
      <div>
        <h2 class="text-lg font-medium m-0">Quản lý project</h2>
        <p class="text-sm text-slate-500 m-0 mt-1">
          CRUD project · wizard PAT → dự án → nhánh → path · path trống →
          <code>project/username/projectName/source</code>
        </p>
      </div>
      <a-button type="primary" :loading="loading" @click="openCreate"
        >Thêm project</a-button
      >
    </div>

    <a-table
      size="small"
      :columns="columns"
      :data-source="tableRows"
      :pagination="false"
      :scroll="{ x: 960 }"
    >
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'active'">
          <a-tag :color="record.isActive ? 'green' : 'default'">
            {{ record.isActive ? "Active" : "—" }}
          </a-tag>
        </template>
        <template v-else-if="column.key === 'cloneStatus'">
          <a-tooltip v-if="record.cloneError" :title="record.cloneError">
            <a-tag color="red">{{ record.cloneStatus }}</a-tag>
          </a-tooltip>
          <a-tag
            v-else
            :color="
              record.cloneStatus === 'ready'
                ? 'green'
                : record.cloneStatus === 'cloning'
                  ? 'blue'
                  : 'default'
            "
            >{{ record.cloneStatus }}</a-tag
          >
        </template>
        <template v-else-if="column.key === 'actions'">
          <div class="flex flex-wrap gap-1">
            <a-button
              size="small"
              :disabled="record.isActive"
              @click="activate(record.id)"
              >Active</a-button
            >
            <a-button size="small" @click="openEdit(record)">Sửa</a-button>
            <a-button
              size="small"
              :loading="cloningId === record.id"
              @click="startClone(record.id)"
              >Clone</a-button
            >
            <a-button size="small" danger @click="remove(record.id)"
              >Xóa</a-button
            >
          </div>
        </template>
      </template>
    </a-table>

    <a-modal
      v-model:open="wizardOpen"
      :title="editId ? 'Sửa project' : 'Thêm project'"
      :footer="null"
      width="640px"
      destroy-on-close
      @cancel="wizardOpen = false"
    >
      <a-steps
        size="small"
        class="mb-5"
        :current="wizardStep"
        :items="steps.map((t) => ({ title: t }))"
      />

      <!-- Step 0: PAT -->
      <div v-if="wizardStep === 0" class="space-y-3">
        <div>
          <label class="text-sm text-slate-600">GitLab host</label>
          <a-input
            v-model:value="form.gitlabHost"
            class="mt-1"
            placeholder="https://gitlab.com"
          />
        </div>
        <div>
          <label class="text-sm text-slate-600">GitLab PAT</label>
          <a-input-password
            v-model:value="form.gitlabToken"
            class="mt-1"
            :placeholder="
              editId ? 'Để trống nếu giữ token cũ' : 'glpat-… (api + read_repository)'
            "
          />
        </div>
        <div class="flex justify-end gap-2 pt-2">
          <a-button @click="wizardOpen = false">Hủy</a-button>
          <a-button
            v-if="editId && !form.gitlabToken"
            type="primary"
            @click="wizardStep = 1"
            >Tiếp (giữ PAT cũ)</a-button
          >
          <a-button
            type="primary"
            :loading="loading"
            @click="loadPreviewProjects"
            >Tiếp · tải dự án</a-button
          >
        </div>
      </div>

      <!-- Step 1: Project -->
      <div v-else-if="wizardStep === 1" class="space-y-3">
        <div>
          <label class="text-sm text-slate-600">Chọn dự án GitLab</label>
          <a-select
            v-if="gitlabProjects.length"
            v-model:value="form.gitlabPath"
            class="w-full mt-1"
            show-search
            placeholder="group/repo"
            :options="
              gitlabProjects.map((p) => ({
                value: p.pathWithNamespace,
                label: p.pathWithNamespace,
              }))
            "
            @change="
              (v: string) => {
                form.projectName = v.split('/').pop() || v;
                form.displayName = form.projectName;
              }
            "
          />
          <a-input
            v-else
            v-model:value="form.gitlabPath"
            class="mt-1"
            placeholder="group/repo"
          />
        </div>
        <div>
          <label class="text-sm text-slate-600">Tên project (Flow)</label>
          <a-input
            v-model:value="form.projectName"
            class="mt-1"
            placeholder="ykk"
            :disabled="Boolean(editId)"
          />
        </div>
        <div class="flex justify-between gap-2 pt-2">
          <a-button @click="wizardStep = 0">Quay lại</a-button>
          <a-button
            type="primary"
            :loading="loading"
            @click="loadBranchesForPath"
            >Tiếp · nhánh chính</a-button
          >
        </div>
      </div>

      <!-- Step 2: Main branch -->
      <div v-else-if="wizardStep === 2" class="space-y-3">
        <div>
          <label class="text-sm text-slate-600">Nhánh chính (base)</label>
          <a-select
            v-model:value="form.mainBranch"
            class="w-full mt-1"
            show-search
            :options="
              (branches.length
                ? branches
                : [form.mainBranch || 'main']
              ).map((b) => ({ value: b, label: b }))
            "
          />
        </div>
        <div class="flex justify-between gap-2 pt-2">
          <a-button @click="wizardStep = 1">Quay lại</a-button>
          <a-button type="primary" @click="nextFromMain"
            >Tiếp · nhánh làm việc</a-button
          >
        </div>
      </div>

      <!-- Step 3: Work branch -->
      <div v-else-if="wizardStep === 3" class="space-y-3">
        <div>
          <label class="text-sm text-slate-600"
            >Nhánh làm việc (optional)</label
          >
          <a-select
            v-model:value="form.workingBranch"
            class="w-full mt-1"
            show-search
            allow-clear
            placeholder="Để trống → auto feat/…"
            :options="branches.map((b) => ({ value: b, label: b }))"
          />
          <a-input
            v-model:value="form.workingBranch"
            class="mt-2"
            placeholder="Hoặc gõ tên nhánh mới"
          />
        </div>
        <div class="flex justify-between gap-2 pt-2">
          <a-button @click="wizardStep = 2">Quay lại</a-button>
          <a-button type="primary" @click="nextFromWork">Tiếp · path</a-button>
        </div>
      </div>

      <!-- Step 4: Path + save -->
      <div v-else class="space-y-3">
        <div>
          <label class="text-sm text-slate-600">Local path</label>
          <a-input
            v-model:value="form.localPath"
            class="mt-1"
            placeholder="Để trống → project/user/name/source"
          />
        </div>
        <a-alert
          type="info"
          show-icon
          :message="
            form.localPath.trim()
              ? `Sẽ dùng path: ${form.localPath.trim()}`
              : `Path trống → clone vào: ${previewDefaultPath || '…'}`
          "
        />
        <div class="flex justify-between gap-2 pt-2">
          <a-button @click="wizardStep = 3">Quay lại</a-button>
          <a-button type="primary" :loading="loading" @click="saveWizard">
            Lưu &amp; clone
          </a-button>
        </div>
      </div>
    </a-modal>
  </div>
</template>
