<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";
import { useRouter } from "vue-router";
import { message } from "ant-design-vue";
import { FolderOpenOutlined } from "@ant-design/icons-vue";
import { api } from "@/api/client";
import { useSessionStore } from "@/stores/session";
import FolderPicker from "@/components/FolderPicker.vue";

const router = useRouter();
const session = useSessionStore();

const step = ref(1);
const loading = ref(false);
const gitlabBaseUrl = ref("https://gitlab.com");
const gitlabPatUrl = ref("");

const form = reactive({
  gitlabToken: "",
  username: "",
  gitlabPath: "",
  repoPath: "",
  baseBranch: "",
  workBranch: "",
});

const projects = ref<Array<{ path_with_namespace: string; name?: string }>>(
  [],
);
const branches = ref<string[]>([]);
const folderOpen = ref(false);

onMounted(async () => {
  try {
    const boot = await fetch("/api/auth/bootstrap").then((r) => r.json());
    gitlabBaseUrl.value = boot.gitlabBaseUrl || "https://gitlab.com";
    gitlabPatUrl.value = boot.gitlabPatUrl || "";
    if (boot.suggestedUsername) form.username = boot.suggestedUsername;
  } catch {
    /* ignore */
  }
});

async function resolveToken() {
  if (!form.gitlabToken.trim()) {
    message.warning("Nhập GitLab PAT");
    return;
  }
  loading.value = true;
  try {
    const res = await fetch("/api/auth/resolve-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ gitlabToken: form.gitlabToken.trim() }),
    }).then(async (r) => {
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || r.statusText);
      return data as { username: string };
    });
    form.username = res.username;
    message.success(`Xin chào @${res.username}`);
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  } finally {
    loading.value = false;
  }
}

async function goStep2() {
  if (!form.gitlabToken.trim()) {
    message.warning("Nhập PAT");
    return;
  }
  loading.value = true;
  try {
    if (!form.username) await resolveToken();
    const loginRes = await api<{
      user: { gitlabUsername: string };
      memberships?: unknown[];
    }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({
        gitlabUsername: form.username,
        gitlabToken: form.gitlabToken.trim(),
      }),
    });
    const uname =
      loginRes.user?.gitlabUsername || form.username || "";
    form.username = uname;
    session.setSession({ username: uname, projectId: null });
    const proj = await api<{
      projects: Array<{
        pathWithNamespace: string;
        name?: string;
        id?: number;
      }>;
    }>("/api/gitlab/my-projects");
    projects.value = (proj.projects || []).map((p) => ({
      path_with_namespace: p.pathWithNamespace,
      name: p.name,
      id: p.id,
    }));
    if (!projects.value.length) {
      message.warning("Token không thấy project nào (cần membership trên GitLab)");
    }
    step.value = 2;
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  } finally {
    loading.value = false;
  }
}

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
    if (!branches.value.length) {
      message.warning("Không lấy được branch (kiểm tra project / PAT)");
    }
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  }
}

async function goStep3() {
  if (!form.gitlabPath || !form.repoPath) {
    message.warning("Chọn project và nhập local path");
    return;
  }
  loading.value = true;
  try {
    await loadBranches();
    step.value = 3;
  } finally {
    loading.value = false;
  }
}

async function finish() {
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
    session.setSession({
      username: form.username,
      projectId: res.project.id,
    });
    await session.refreshMe();
    message.success("Đã vào workspace");
    router.push({ name: "work" });
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div
    class="h-full min-h-0 overflow-y-auto flex items-center justify-center p-6"
  >
    <div
      class="w-full max-w-md rounded-3xl border border-line bg-surface-raised/90 backdrop-blur-md p-7 shadow-float"
    >
      <div class="mb-5">
        <div class="brand-mark text-sm font-semibold mb-1">Flow Auto Work</div>
        <h1 class="text-2xl font-semibold text-ink m-0">
          {{
            step === 1
              ? "Kết nối GitLab"
              : step === 2
                ? "Chọn dự án"
                : "Cấu hình nhánh"
          }}
        </h1>
        <p class="text-ink-muted text-sm mt-1 mb-0">Bước {{ step }}/3</p>
      </div>

      <div v-show="step === 1" class="space-y-3">
        <a-form layout="vertical">
          <a-form-item label="GitLab PAT">
            <a-input-password
              v-model:value="form.gitlabToken"
              placeholder="glpat-…"
              autocomplete="off"
            />
            <div class="text-xs text-ink-faint mt-1">
              <a
                :href="gitlabPatUrl || `${gitlabBaseUrl}/-/user_settings/personal_access_tokens`"
                target="_blank"
                rel="noopener"
                class="text-accent font-medium"
                >Tạo PAT</a
              >
              · scope <code>api</code>
            </div>
          </a-form-item>
        </a-form>
        <a-button type="primary" block :loading="loading" @click="goStep2"
          >Tiếp tục</a-button
        >
      </div>

      <div v-show="step === 2" class="space-y-3">
        <a-form layout="vertical">
          <a-form-item :label="`Project (${projects.length})`">
            <a-select
              v-model:value="form.gitlabPath"
              show-search
              :filter-option="
                (input: string, option: { label?: string }) =>
                  (option?.label || '')
                    .toLowerCase()
                    .includes(String(input).toLowerCase())
              "
              placeholder="Gõ để tìm group/project…"
              :options="
                projects.map((p) => ({
                  value: p.path_with_namespace,
                  label: p.path_with_namespace,
                }))
              "
              class="w-full"
              :not-found-content="
                projects.length ? 'Không khớp' : 'Không có project'
              "
            />
          </a-form-item>
          <a-form-item label="Local repo path">
            <div class="flex gap-2">
              <a-input
                v-model:value="form.repoPath"
                placeholder="/Users/…/repo"
                class="flex-1"
              />
              <a-button @click="folderOpen = true">
                <template #icon><FolderOpenOutlined /></template>
                Chọn
              </a-button>
            </div>
          </a-form-item>
        </a-form>
        <FolderPicker
          v-model:open="folderOpen"
          v-model="form.repoPath"
        />
        <div class="flex gap-2">
          <a-button @click="step = 1">Back</a-button>
          <a-button
            type="primary"
            class="flex-1"
            :loading="loading"
            @click="goStep3"
            >Tiếp tục</a-button
          >
        </div>
      </div>

      <div v-show="step === 3" class="space-y-3">
        <a-form layout="vertical">
          <a-form-item :label="`Base / project branch (${branches.length})`">
            <a-select
              v-model:value="form.baseBranch"
              show-search
              :filter-option="
                (input: string, option: { label?: string }) =>
                  (option?.label || '')
                    .toLowerCase()
                    .includes(String(input).toLowerCase())
              "
              :options="branches.map((b) => ({ value: b, label: b }))"
              class="w-full"
              allow-clear
              :not-found-content="
                branches.length ? 'Không khớp' : 'Không có branch'
              "
            />
          </a-form-item>
          <a-form-item label="Work branch (optional)">
            <a-input
              v-model:value="form.workBranch"
              placeholder="feat/… hoặc để trống = auto"
            />
          </a-form-item>
        </a-form>
        <div class="flex gap-2">
          <a-button @click="step = 2">Back</a-button>
          <a-button
            type="primary"
            class="flex-1"
            :loading="loading"
            @click="finish"
            >Vào workspace</a-button
          >
        </div>
      </div>
    </div>
  </div>
</template>
