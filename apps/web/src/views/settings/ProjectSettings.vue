<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from "vue";
import { message, Modal } from "ant-design-vue";
import { MoreOutlined } from "@ant-design/icons-vue";
import { api } from "@/api/client";
import { API } from "@/api/endpoints";
import { useSessionStore } from "@/stores/session";

const session = useSessionStore();
const loading = ref(false);
const cloningId = ref<string | null>(null);
const pollTimer = ref<ReturnType<typeof setInterval> | null>(null);

const wizardOpen = ref(false);
const wizardStep = ref(0);
const editId = ref<string | null>(null);
/** projectName when edit opened — detect rename vs other field updates */
const editOriginalName = ref<string | null>(null);

type ProjectPublic = {
  id: string;
  projectName?: string;
  displayName?: string;
  gitProvider?: "gitlab" | "github";
  gitlabPath: string;
  gitlabHost?: string;
  localPath?: string;
  repoPath?: string;
  mainBranch?: string | null;
  workingBranch?: string | null;
  defaultCommitMode?: "manual" | "auto" | null;
  allowedMilestones?: string[];
  isActive?: boolean;
  cloneStatus?: string;
  cloneError?: string | null;
  hasGitlabToken?: boolean;
};

const form = reactive({
  gitProvider: "gitlab" as "gitlab" | "github",
  gitlabHost: "https://gitlab.com",
  gitlabToken: "",
  gitlabPath: "",
  projectName: "",
  displayName: "",
  mainBranch: "main",
  workingBranch: "",
  localPath: "",
  /** Project default for new jobs — per-job toggle can still override */
  defaultCommitMode: "auto" as "manual" | "auto",
  /** Empty = no Workbench milestone restriction */
  allowedMilestones: [] as string[],
});

const gitlabProjects = ref<
  Array<{ pathWithNamespace: string; name?: string; id?: number }>
>([]);
const branches = ref<string[]>([]);
const milestoneOptions = ref<string[]>([]);
const previewDefaultPath = ref("");

const isGithub = computed(() => form.gitProvider === "github");
const forgeLabel = computed(() => (isGithub.value ? "GitHub" : "GitLab"));
const patCreateUrl = computed(() =>
  isGithub.value
    ? "https://github.com/settings/tokens/new"
    : "https://gitlab.com/-/user_settings/personal_access_tokens",
);
const patHint = computed(() =>
  isGithub.value
    ? "ghp_… classic PAT (not fine-grained) with repo scope"
    : "glpat-… (api + read_repository)",
);
const pathPlaceholder = computed(() =>
  isGithub.value ? "owner/repo" : "group/repo",
);

const steps = computed(() => [
  `${forgeLabel.value} PAT`,
  "Project",
  "Main branch",
  "Work branch",
  "Local path",
]);

const tableRows = computed(() =>
  session.memberships.map((m) => {
    const p = m.project as ProjectPublic;
    return {
      key: m.projectId,
      id: m.projectId,
      name: p.projectName || p.displayName || p.gitlabPath,
      gitProvider: p.gitProvider === "github" ? "github" : "gitlab",
      gitlabPath: p.gitlabPath,
      mainBranch: p.mainBranch || m.baseBranch || "—",
      workBranch: p.workingBranch || m.workBranch || "—",
      defaultCommitMode:
        p.defaultCommitMode === "manual" ? "manual" : "auto",
      localPath: p.localPath || p.repoPath || "—",
      cloneStatus: p.cloneStatus || "—",
      cloneError: p.cloneError,
      isActive: Boolean(p.isActive),
      hasToken: Boolean(p.hasGitlabToken),
    };
  }),
);

const columns = [
  { title: "Name", dataIndex: "name", key: "name", ellipsis: true },
  { title: "Forge", dataIndex: "gitProvider", key: "gitProvider", width: 90 },
  { title: "Repo", dataIndex: "gitlabPath", key: "gitlabPath", ellipsis: true },
  { title: "Main", dataIndex: "mainBranch", key: "mainBranch", width: 100 },
  { title: "Work", dataIndex: "workBranch", key: "workBranch", width: 120 },
  { title: "Commit", dataIndex: "defaultCommitMode", key: "defaultCommitMode", width: 90 },
  { title: "Path", dataIndex: "localPath", key: "localPath", ellipsis: true },
  { title: "Clone", dataIndex: "cloneStatus", key: "cloneStatus", width: 100 },
  { title: "Action", key: "actions", width: 72, align: "center" as const },
];

const wizardWidth = computed(() => {
  if (typeof window === "undefined") return 640;
  return window.innerWidth < 640 ? "calc(100vw - 24px)" : 640;
});

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
  editOriginalName.value = null;
  form.gitProvider = "gitlab";
  form.gitlabHost = "https://gitlab.com";
  form.gitlabToken = "";
  form.gitlabPath = "";
  form.projectName = "";
  form.displayName = "";
  form.mainBranch = "main";
  form.workingBranch = "";
  form.localPath = "";
  form.defaultCommitMode = "auto";
  form.allowedMilestones = [];
  gitlabProjects.value = [];
  branches.value = [];
  milestoneOptions.value = [];
}

function openCreate() {
  resetWizard();
  wizardOpen.value = true;
}

function onProviderChange(v: "gitlab" | "github") {
  form.gitProvider = v;
  form.gitlabHost =
    v === "github" ? "https://github.com" : "https://gitlab.com";
  form.gitlabPath = "";
  gitlabProjects.value = [];
  branches.value = [];
}

function openEdit(row: (typeof tableRows.value)[0]) {
  resetWizard();
  editId.value = row.id;
  const m = session.memberships.find((x) => x.projectId === row.id);
  const p = m?.project as ProjectPublic | undefined;
  form.gitProvider = p?.gitProvider === "github" ? "github" : "gitlab";
  form.gitlabHost =
    p?.gitlabHost ||
    (form.gitProvider === "github"
      ? "https://github.com"
      : "https://gitlab.com");
  form.gitlabPath = p?.gitlabPath || row.gitlabPath;
  form.projectName = p?.projectName || row.name;
  form.displayName = p?.displayName || form.projectName;
  editOriginalName.value = form.projectName;
  form.mainBranch =
    (p?.mainBranch || m?.baseBranch || "main") as string;
  form.workingBranch =
    (p?.workingBranch || m?.workBranch || "") as string;
  form.localPath = (p?.localPath || p?.repoPath || "") as string;
  form.defaultCommitMode =
    p?.defaultCommitMode === "manual" ? "manual" : "auto";
  form.allowedMilestones = Array.isArray(p?.allowedMilestones)
    ? [...p.allowedMilestones]
    : [];
  form.gitlabToken = "";
  wizardStep.value = 0;
  wizardOpen.value = true;
  void loadMilestoneOptionsForEdit();
}

async function loadMilestoneOptionsForEdit() {
  if (!editId.value) return;
  try {
    const res = await api<{ milestones: string[] }>(
      API.me.projectMilestones(editId.value),
    );
    milestoneOptions.value = res.milestones || [];
    // Keep selected titles that the forge no longer returns
    for (const t of form.allowedMilestones) {
      if (t && !milestoneOptions.value.includes(t)) {
        milestoneOptions.value.push(t);
      }
    }
  } catch {
    milestoneOptions.value = [...form.allowedMilestones];
  }
}

async function loadPreviewProjects() {
  if (!form.gitlabToken.trim()) {
    message.warning(`Enter ${forgeLabel.value} PAT`);
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
      body: JSON.stringify({
        gitlabToken: form.gitlabToken.trim(),
        gitlabHost: form.gitlabHost,
        gitProvider: form.gitProvider,
      }),
    });
    gitlabProjects.value = res.projects || [];
    if (!gitlabProjects.value.length) {
      message.warning("PAT found no repositories");
      return;
    }
    wizardStep.value = 1;
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  } finally {
    loading.value = false;
  }
}

/** Merge remote/local branch names; keep current form values selectable. */
function applyBranchNames(names: Iterable<string>) {
  const set = new Set<string>([...names].filter(Boolean));
  if (form.mainBranch.trim()) set.add(form.mainBranch.trim());
  if (form.workingBranch.trim()) set.add(form.workingBranch.trim());
  branches.value = [...set].sort((a, b) => a.localeCompare(b));
}

/** Load branches via stored project PAT (edit wizard without re-entering token). */
async function loadBranchesForEdit() {
  if (!editId.value || !form.gitlabPath.trim()) return;
  const params = new URLSearchParams({
    gitlabPath: form.gitlabPath.trim(),
    projectId: editId.value,
  });
  if (form.localPath.trim()) {
    params.set("repoPath", form.localPath.trim());
  }
  const res = await api<{
    remote?: Array<{ name: string }>;
    local?: string[];
    defaultBranch?: string | null;
  }>(`${API.gitlab.branches}?${params.toString()}`);
  applyBranchNames([
    ...(res.remote || []).map((b) => b.name),
    ...(res.local || []),
  ]);
  if (!form.mainBranch.trim() || form.mainBranch === "main") {
    form.mainBranch =
      res.defaultBranch ||
      branches.value.find((b) => b === "main" || b === "master") ||
      branches.value[0] ||
      form.mainBranch ||
      "main";
  }
}

async function loadBranchesForPath() {
  if (!form.gitlabPath.trim()) {
    message.warning(`Select a ${forgeLabel.value} repository`);
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
        milestones?: string[];
      }>("/api/gitlab/preview", {
        method: "POST",
        body: JSON.stringify({
          gitlabToken: form.gitlabToken.trim(),
          gitlabPath: form.gitlabPath.trim(),
          gitlabHost: form.gitlabHost,
          gitProvider: form.gitProvider,
        }),
      });
      applyBranchNames((res.branches || []).map((b) => b.name));
      milestoneOptions.value = res.milestones || [];
      if (!form.mainBranch || form.mainBranch === "main") {
        form.mainBranch =
          res.defaultBranch ||
          branches.value.find((b) => b === "main" || b === "master") ||
          branches.value[0] ||
          "main";
      }
    } else if (editId.value) {
      // Keep existing PAT: preview needs a raw token; use /gitlab/branches with stored secrets
      await Promise.all([loadMilestoneOptionsForEdit(), loadBranchesForEdit()]);
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
    message.warning("Select main branch");
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
    message.warning("Missing path or GitLab path");
    return;
  }

  if (!opts?.silentConfirm) {
    const ok = await new Promise<boolean>((resolve) => {
      Modal.confirm({
        title: "Clone source?",
        content: `Will clone to:\n${localPath}`,
        okText: "Clone",
        cancelText: "Cancel",
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
    message.info(`Cloning source to:\n${localPath}`);
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

    // Flow name drives list label + local folder …/{name}/source
    const flowName = form.projectName.trim();
    form.displayName = flowName;

    if (editId.value) {
      if (!flowName) {
        message.warning("Enter Flow project name");
        loading.value = false;
        return;
      }
      const dup = session.memberships.find(
        (m) =>
          m.projectId !== editId.value &&
          (m.project?.projectName || "").trim().toLowerCase() ===
            flowName.toLowerCase(),
      );
      if (dup) {
        message.error(
          `Name "${flowName}" is already used — conflicts with source save path. Choose another name.`,
        );
        loading.value = false;
        return;
      }
      const renaming =
        Boolean(editOriginalName.value) &&
        flowName !== editOriginalName.value;
      const res = await api<{
        folderRenamed?: boolean;
        project?: ProjectPublic;
      }>(`/api/me/projects/${encodeURIComponent(editId.value)}`, {
        method: "PUT",
        body: JSON.stringify({
          baseBranch: form.mainBranch || "",
          workBranch: form.workingBranch || "",
          defaultCommitMode: form.defaultCommitMode,
          allowedMilestones: form.allowedMilestones,
          localPath: renaming ? undefined : resolvedPath || undefined,
          gitlabToken: form.gitlabToken || undefined,
          gitProvider: form.gitProvider,
          gitlabHost: form.gitlabHost || undefined,
          gitlabPath: form.gitlabPath || undefined,
          projectName: flowName,
          displayName: flowName,
        }),
      });
      await session.refreshMe();
      wizardOpen.value = false;
      const newPath = res.project?.localPath || resolvedPath;
      if (res.folderRenamed) {
        message.success(`Renamed + folder moved:\n${newPath}`);
      } else if (pathEmpty && newPath && !renaming) {
        message.success(
          `Saved. Empty path → using default folder:\n${newPath}`,
        );
        await startClone(editId.value, {
          localPath: newPath,
          silentConfirm: true,
        });
      } else {
        message.success(
          newPath ? `Project updated\n${newPath}` : "Project updated",
        );
      }
      return;
    }

    if (!form.gitlabToken.trim()) {
      message.warning("GitLab PAT required");
      return;
    }
    if (!form.gitlabPath.trim() || !flowName) {
      message.warning("Missing project / project name");
      return;
    }
    const dupCreate = session.memberships.find(
      (m) =>
        (m.project?.projectName || "").trim().toLowerCase() ===
        flowName.toLowerCase(),
    );
    if (dupCreate) {
      message.error(
        `Name "${flowName}" is already used — conflicts with source save path. Choose another name.`,
      );
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
        projectName: flowName,
        gitlabPath: form.gitlabPath.trim(),
        gitProvider: form.gitProvider,
        gitlabHost:
          form.gitlabHost ||
          (form.gitProvider === "github"
            ? "https://github.com"
            : "https://gitlab.com"),
        gitlabToken: form.gitlabToken,
        localPath: pathEmpty ? undefined : form.localPath.trim(),
        mainBranch: form.mainBranch || undefined,
        workingBranch: form.workingBranch || undefined,
        defaultCommitMode: form.defaultCommitMode,
        allowedMilestones: form.allowedMilestones,
        displayName: flowName,
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
        `Project created. Empty path → cloning to default folder:\n${clonePath}`,
        6,
      );
    } else {
      message.success(`Project created. Cloning to:\n${clonePath}`, 5);
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
    const { useWorkStore } = await import("@/stores/work");
    useWorkStore().clearOpenSelection();
    await session.activateProject(id);
    message.success("Project activated");
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  } finally {
    loading.value = false;
  }
}

async function remove(id: string) {
  Modal.confirm({
    title: "Delete project?",
    content: "Removes Flow metadata only (does not delete local folder).",
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
      message.success("Project deleted");
    },
  });
}

type ProjectRow = (typeof tableRows.value)[number];

function onProjectAction(key: string, record: ProjectRow) {
  if (key === "active") void activate(record.id);
  else if (key === "edit") openEdit(record);
  else if (key === "clone") void startClone(record.id);
  else if (key === "delete") void remove(record.id);
}

onMounted(async () => {
  await session.refreshMe().catch(() => undefined);
});
</script>

<template>
  <div class="space-y-4 min-w-0">
    <div class="flex items-start justify-between gap-2 flex-wrap">
      <div class="min-w-0">
        <h2 class="text-lg font-medium m-0">Project management</h2>
        <p class="text-sm text-ink-muted m-0 mt-1 hidden sm:block">
          GitLab or GitHub classic PAT → repository → branch → local path
        </p>
      </div>
      <a-button type="primary" size="small" :loading="loading" @click="openCreate"
        >Add project</a-button
      >
    </div>

    <!-- Desktop table -->
    <div class="hidden md:block min-w-0 overflow-x-auto">
      <a-table
        size="small"
        :columns="columns"
        :data-source="tableRows"
        :pagination="false"
        :scroll="{ x: 960 }"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'name'">
            <span class="inline-flex items-center gap-1.5 min-w-0">
              <span class="truncate">{{ record.name }}</span>
              <a-tag
                v-if="record.isActive"
                class="!m-0 shrink-0"
                color="green"
              >
                Active
              </a-tag>
            </span>
          </template>
          <template v-else-if="column.key === 'gitProvider'">
            <a-tag :color="record.gitProvider === 'github' ? 'purple' : 'geekblue'">
              {{ record.gitProvider === "github" ? "GitHub" : "GitLab" }}
            </a-tag>
          </template>
          <template v-else-if="column.key === 'defaultCommitMode'">
            <a-tag
              :color="record.defaultCommitMode === 'manual' ? 'orange' : 'blue'"
            >
              {{ record.defaultCommitMode === "manual" ? "Manual" : "Auto" }}
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
            <a-dropdown :trigger="['click']">
              <a-button size="small" type="text" class="!px-1.5">
                <MoreOutlined />
              </a-button>
              <template #overlay>
                <a-menu @click="({ key }) => onProjectAction(String(key), record)">
                  <a-menu-item key="active" :disabled="record.isActive">
                    Set active
                  </a-menu-item>
                  <a-menu-item key="edit">Edit</a-menu-item>
                  <a-menu-item
                    key="clone"
                    :disabled="cloningId === record.id"
                  >
                    {{ cloningId === record.id ? "Cloning…" : "Clone" }}
                  </a-menu-item>
                  <a-menu-divider />
                  <a-menu-item key="delete" danger>Delete</a-menu-item>
                </a-menu>
              </template>
            </a-dropdown>
          </template>
        </template>
      </a-table>
    </div>

    <!-- Mobile cards -->
    <div class="md:hidden space-y-2">
      <div
        v-for="record in tableRows"
        :key="record.id"
        class="faw-project-card"
      >
        <div class="flex items-start justify-between gap-2">
          <div class="min-w-0">
            <div class="font-semibold text-ink truncate">
              {{ record.name }}
              <a-tag
                v-if="record.isActive"
                class="!m-0 !ml-1 !text-[10px] align-middle"
                color="green"
              >
                Active
              </a-tag>
            </div>
            <div class="text-[11px] text-ink-faint font-mono truncate mt-0.5">
              <a-tag
                class="!m-0 !mr-1 !text-[10px]"
                :color="record.gitProvider === 'github' ? 'purple' : 'geekblue'"
              >
                {{ record.gitProvider === "github" ? "GH" : "GL" }}
              </a-tag>
              {{ record.gitlabPath }}
            </div>
          </div>
          <a-dropdown :trigger="['click']">
            <a-button size="small" type="text" class="shrink-0 !px-1.5">
              <MoreOutlined />
            </a-button>
            <template #overlay>
              <a-menu @click="({ key }) => onProjectAction(String(key), record)">
                <a-menu-item key="active" :disabled="record.isActive">
                  Set active
                </a-menu-item>
                <a-menu-item key="edit">Edit</a-menu-item>
                <a-menu-item key="clone" :disabled="cloningId === record.id">
                  {{ cloningId === record.id ? "Cloning…" : "Clone" }}
                </a-menu-item>
                <a-menu-divider />
                <a-menu-item key="delete" danger>Delete</a-menu-item>
              </a-menu>
            </template>
          </a-dropdown>
        </div>
        <div class="faw-project-card__meta">
          <span>Main <b>{{ record.mainBranch }}</b></span>
          <span>Work <b>{{ record.workBranch }}</b></span>
          <span>
            <a-tag
              class="!m-0 !text-[10px]"
              :color="record.defaultCommitMode === 'manual' ? 'orange' : 'blue'"
            >
              {{ record.defaultCommitMode === "manual" ? "Manual" : "Auto" }}
            </a-tag>
          </span>
          <span>
            <a-tag
              class="!m-0 !text-[10px]"
              :color="
                record.cloneStatus === 'ready'
                  ? 'green'
                  : record.cloneStatus === 'cloning'
                    ? 'blue'
                    : record.cloneError
                      ? 'red'
                      : 'default'
              "
              >{{ record.cloneStatus }}</a-tag
            >
          </span>
        </div>
        <div class="text-[11px] text-ink-faint truncate" :title="String(record.localPath)">
          {{ record.localPath }}
        </div>
      </div>
      <a-empty v-if="!tableRows.length" description="No projects yet" />
    </div>

    <a-modal
      v-model:open="wizardOpen"
      :title="editId ? 'Edit project' : 'Add project'"
      :footer="null"
      :width="wizardWidth"
      wrap-class-name="faw-settings-modal"
      destroy-on-close
      @cancel="wizardOpen = false"
    >
      <a-steps
        size="small"
        class="mb-5 faw-wizard-steps"
        :current="wizardStep"
        :items="steps.map((t) => ({ title: t }))"
      />

      <!-- Step 0: PAT -->
      <div v-if="wizardStep === 0" class="space-y-3">
        <div>
          <label class="text-sm text-slate-600">Forge</label>
          <a-radio-group
            class="mt-1 flex flex-wrap gap-3"
            :value="form.gitProvider"
            :disabled="Boolean(editId)"
            @update:value="onProviderChange"
          >
            <a-radio value="gitlab">GitLab</a-radio>
            <a-radio value="github">GitHub (classic PAT)</a-radio>
          </a-radio-group>
          <p v-if="editId" class="text-xs text-ink-muted m-0 mt-1">
            Forge cannot be changed after create — create a new project instead.
          </p>
        </div>
        <div>
          <label class="text-sm text-slate-600">{{ forgeLabel }} host</label>
          <a-input
            v-model:value="form.gitlabHost"
            class="mt-1"
            :placeholder="
              isGithub ? 'https://github.com' : 'https://gitlab.com'
            "
          />
        </div>
        <div>
          <label class="text-sm text-slate-600">{{ forgeLabel }} PAT</label>
          <a-input-password
            v-model:value="form.gitlabToken"
            class="mt-1"
            :placeholder="
              editId ? 'Leave blank to keep existing token' : patHint
            "
          />
          <p class="text-xs text-ink-muted m-0 mt-1">
            <a :href="patCreateUrl" target="_blank" rel="noopener noreferrer">
              Create {{ forgeLabel }} personal access token
            </a>
            <template v-if="isGithub">
              — dùng
              <strong>classic</strong> (<code>ghp_</code>) scope
              <code>repo</code>. Fine-grained
              <strong>không</strong> lấy được repo invite (outside collaborator). Org
              có SAML SSO → Authorize SSO trên token đó.
            </template>
          </p>
        </div>
        <div class="flex justify-end gap-2 pt-2">
          <a-button @click="wizardOpen = false">Cancel</a-button>
          <a-button
            v-if="editId && !form.gitlabToken"
            type="primary"
            @click="wizardStep = 1"
            >Next (keep existing PAT)</a-button
          >
          <a-button
            type="primary"
            :loading="loading"
            @click="loadPreviewProjects"
            >Next · load projects</a-button
          >
        </div>
      </div>

      <!-- Step 1: Project -->
      <div v-else-if="wizardStep === 1" class="space-y-3">
        <div>
          <label class="text-sm text-slate-600"
            >Select {{ forgeLabel }} repository</label
          >
          <!-- AutoComplete: pick from PAT list OR type owner/repo when invite missing from list -->
          <a-auto-complete
            v-model:value="form.gitlabPath"
            class="w-full mt-1"
            :placeholder="pathPlaceholder"
            :options="
              gitlabProjects.map((p) => ({
                value: p.pathWithNamespace,
              }))
            "
            @select="
              (v: string) => {
                form.projectName = v.split('/').pop() || v;
                form.displayName = form.projectName;
              }
            "
          />
          <p v-if="isGithub" class="text-xs text-ink-muted m-0 mt-1">
            Không thấy repo invite trong dropdown? Gõ tay
            <code>owner/repo</code> (đã Accept invite trên GitHub). Token phải
            truy cập được repo đó.
          </p>
        </div>
        <div>
          <label class="text-sm text-slate-600">Flow project name</label>
          <a-input
            v-model:value="form.projectName"
            class="mt-1"
            placeholder="ykk"
            @update:value="(v: string) => { form.displayName = v; }"
          />
          <p class="text-xs text-ink-muted m-0 mt-1">
            This name appears in the list, must be
            <strong>unique</strong>, and is the folder
            <code>…/name/source</code>.
            <template v-if="editId">
              Renaming will move the folder when using the default path.
            </template>
          </p>
        </div>
        <div class="flex justify-between gap-2 pt-2">
          <a-button @click="wizardStep = 0">Back</a-button>
          <a-button
            type="primary"
            :loading="loading"
            @click="loadBranchesForPath"
            >Next · main branch</a-button
          >
        </div>
      </div>

      <!-- Step 2: Main branch -->
      <div v-else-if="wizardStep === 2" class="space-y-3">
        <div>
          <label class="text-sm text-slate-600">Main branch (base)</label>
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
          <a-button @click="wizardStep = 1">Back</a-button>
          <a-button type="primary" @click="nextFromMain"
            >Next · work branch</a-button
          >
        </div>
      </div>

      <!-- Step 3: Work branch + default commit mode -->
      <div v-else-if="wizardStep === 3" class="space-y-3">
        <div>
          <label class="text-sm text-slate-600"
            >Work branch (optional)</label
          >
          <a-select
            v-model:value="form.workingBranch"
            class="w-full mt-1"
            show-search
            allow-clear
            placeholder="Select existing branch (or leave blank)"
            :options="
              (branches.length
                ? branches
                : form.workingBranch
                  ? [form.workingBranch]
                  : []
              ).map((b) => ({ value: b, label: b }))
            "
          />
          <a-input
            v-model:value="form.workingBranch"
            class="mt-2"
            placeholder="Or type a new branch name"
          />
        </div>
        <div
          class="rounded-lg border border-[var(--app-border)] bg-[var(--app-panel-soft)] px-3 py-2.5 flex items-center justify-between gap-3"
        >
          <div class="min-w-0">
            <div class="text-sm text-ink-soft font-medium">
              Default Auto commit
            </div>
            <div class="text-xs text-ink-muted mt-0.5">
              Job mới trong project lấy mặc định này. Vẫn đổi được trên từng
              task (tab Diff).
            </div>
          </div>
          <a-switch
            :checked="form.defaultCommitMode === 'auto'"
            checked-children="Auto"
            un-checked-children="Manual"
            @change="
              (v: boolean) =>
                (form.defaultCommitMode = v ? 'auto' : 'manual')
            "
          />
        </div>
        <div>
          <label class="text-sm text-slate-600">Allowed milestones</label>
          <a-select
            v-model:value="form.allowedMilestones"
            mode="multiple"
            allow-clear
            show-search
            class="w-full mt-1"
            placeholder="Leave empty → all milestones"
            :options="
              milestoneOptions.map((m) => ({ value: m, label: m }))
            "
          />
          <p class="text-xs text-ink-muted mt-1 mb-0">
            If set, Workbench only shows open tasks whose milestone is in this
            list.
          </p>
        </div>
        <div class="flex justify-between gap-2 pt-2">
          <a-button @click="wizardStep = 2">Back</a-button>
          <a-button type="primary" @click="nextFromWork">Next · path</a-button>
        </div>
      </div>

      <!-- Step 4: Path + save -->
      <div v-else class="space-y-3">
        <div>
          <label class="text-sm text-slate-600">Local path</label>
          <a-input
            v-model:value="form.localPath"
            class="mt-1"
            placeholder="Leave blank → project/user/name/source"
          />
        </div>
        <a-alert
          type="info"
          show-icon
          :message="
            form.localPath.trim()
              ? `Will use path: ${form.localPath.trim()}`
              : `Empty path → clone to: ${previewDefaultPath || '…'}`
          "
        />
        <div class="flex justify-between gap-2 pt-2">
          <a-button @click="wizardStep = 3">Back</a-button>
          <a-button type="primary" :loading="loading" @click="saveWizard">
            Save &amp; clone
          </a-button>
        </div>
      </div>
    </a-modal>
  </div>
</template>
