<script setup lang="ts">
import { onMounted, reactive, ref, computed } from "vue";
import { useRouter } from "vue-router";
import { message } from "ant-design-vue";
import { FolderOpenOutlined } from "@ant-design/icons-vue";
import { api } from "@/api/client";
import { useSessionStore, type Membership } from "@/stores/session";
import FolderPicker from "@/components/FolderPicker.vue";

const LAST_LOGIN_KEY = "flow_auto_work_last_login";

type LastLogin = {
  username: string;
  projectId: string | null;
  gitlabPath?: string | null;
};

const router = useRouter();
const session = useSessionStore();

const step = ref(1);
const loading = ref(false);
const gitlabBaseUrl = ref("https://gitlab.com");
const gitlabPatUrl = ref("");
const returningUser = ref(false);
const savedMemberships = ref<Membership[]>([]);

const form = reactive({
  gitlabToken: "",
  username: "",
  gitlabPath: "",
  repoPath: "",
  baseBranch: "",
  workBranch: "",
});

const projects = ref<
  Array<{ path_with_namespace: string; name?: string; id?: number }>
>([]);
const branches = ref<string[]>([]);
const folderOpen = ref(false);

function loadLastLogin(): LastLogin | null {
  try {
    const raw = localStorage.getItem(LAST_LOGIN_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as LastLogin;
  } catch {
    return null;
  }
}

function saveLastLogin(opts: LastLogin) {
  localStorage.setItem(
    LAST_LOGIN_KEY,
    JSON.stringify({
      username: opts.username,
      projectId: opts.projectId,
      gitlabPath: opts.gitlabPath || null,
    }),
  );
}

const canSkipPat = computed(
  () => returningUser.value && Boolean(form.username.trim()),
);

onMounted(async () => {
  try {
    const boot = await fetch("/api/auth/bootstrap").then((r) => r.json());
    gitlabBaseUrl.value = boot.gitlabBaseUrl || "https://gitlab.com";
    gitlabPatUrl.value = boot.gitlabPatUrl || "";
    if (boot.suggestedUsername) form.username = boot.suggestedUsername;
  } catch {
    /* ignore */
  }
  const last = loadLastLogin();
  if (last?.username) {
    form.username = last.username;
    returningUser.value = true;
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

async function enterWorkspace(memberships: Membership[], preferProjectId?: string | null) {
  const last = loadLastLogin();
  const prefer =
    preferProjectId ||
    last?.projectId ||
    session.session.projectId ||
    null;
  const picked =
    (prefer &&
      memberships.find(
        (m) => m.projectId === prefer || m.project?.id === prefer,
      )) ||
    memberships[0];
  if (!picked?.projectId) return false;

  const username = (form.username || session.session.username || "")
    .trim()
    .replace(/^@/, "");
  session.setSession({
    username,
    projectId: picked.projectId,
  });
  session.setMemberships(memberships);
  saveLastLogin({
    username,
    projectId: picked.projectId,
    gitlabPath: picked.project?.gitlabPath,
  });
  message.success(
    `Chào @${username} · ${picked.project?.displayName || picked.project?.gitlabPath || picked.projectId}`,
  );
  await router.replace({ name: "work" });
  void session.refreshMe().catch(() => undefined);
  return true;
}

async function goStep2() {
  if (!form.gitlabToken.trim() && !canSkipPat.value) {
    message.warning("Nhập PAT (hoặc dùng tài khoản đã lưu)");
    return;
  }
  if (!form.gitlabToken.trim() && !form.username.trim()) {
    message.warning("Nhập username hoặc PAT");
    return;
  }
  loading.value = true;
  try {
    if (form.gitlabToken.trim() && !form.username) await resolveToken();
    const body: Record<string, string> = {
      gitlabUsername: form.username.trim().replace(/^@/, ""),
    };
    if (form.gitlabToken.trim()) {
      body.gitlabToken = form.gitlabToken.trim();
    }
    const loginRes = await api<{
      user: { gitlabUsername: string; hasGitlabToken?: boolean };
      memberships?: Membership[];
      accessToken: string;
      refreshToken: string;
      expiresIn?: number;
      accessExpiresAt?: number;
    }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify(body),
    });
    const uname =
      loginRes.user?.gitlabUsername || form.username || "";
    form.username = uname;
    session.setAuthTokens({
      username: uname,
      accessToken: loginRes.accessToken,
      refreshToken: loginRes.refreshToken,
      expiresIn: loginRes.expiresIn,
      accessExpiresAt: loginRes.accessExpiresAt,
    });
    session.setSession({ username: uname });

    const memberships = (loginRes.memberships || []) as Membership[];
    savedMemberships.value = memberships;

    // Đã có project + path + branch trên server → vào thẳng Work
    if (memberships.length > 0) {
      const ok = await enterWorkspace(memberships);
      if (ok) return;
    }

    // Lần đầu / chưa join project → wizard chọn project
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
    const last = loadLastLogin();
    if (last?.gitlabPath) form.gitlabPath = last.gitlabPath;
    if (!projects.value.length) {
      message.warning(
        "Token không thấy project nào (cần membership trên GitLab)",
      );
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
    const res = await api<{
      project: { id: string; gitlabPath?: string };
      memberships?: Membership[];
    }>("/api/projects/join", {
      method: "POST",
      body: JSON.stringify({
        gitlabPath: form.gitlabPath,
        repoPath: form.repoPath,
        baseBranch: form.baseBranch || undefined,
        workBranch: form.workBranch || undefined,
      }),
    });
    const projectId =
      res.project?.id ||
      res.memberships?.[0]?.projectId ||
      res.memberships?.[0]?.project?.id;
    const username = (form.username || session.session.username || "")
      .trim()
      .replace(/^@/, "");
    if (!projectId || !username) {
      throw new Error("Join OK nhưng thiếu projectId/username");
    }
    if (!session.session.accessToken && !session.session.refreshToken) {
      throw new Error("Mất token phiên — đăng nhập lại");
    }

    session.setSession({ username, projectId });
    if (res.memberships?.length) session.setMemberships(res.memberships);
    saveLastLogin({
      username,
      projectId,
      gitlabPath: form.gitlabPath,
    });
    message.success("Đã vào workspace");
    await router.replace({ name: "work" });
    void session.refreshMe().catch(() => undefined);
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  } finally {
    loading.value = false;
  }
}

function setupNewProject() {
  step.value = 2;
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
              ? returningUser
                ? "Kết nối GitLab"
                : "Kết nối GitLab"
              : step === 2
                ? "Chọn dự án"
                : "Cấu hình nhánh"
          }}
        </h1>
        <p class="text-ink-muted text-sm mt-1 mb-0">
          <template v-if="step === 1 && returningUser">
          </template>
          <template v-else>Bước {{ step }}/3</template>
        </p>
      </div>

      <div v-show="step === 1" class="space-y-3">
        <a-form layout="vertical">
          <a-form-item
            :label="canSkipPat ? 'GitLab PAT (optional — đổi token)' : 'GitLab PAT'"
          >
            <a-input-password
              v-model:value="form.gitlabToken"
              placeholder="glpat-…"
              autocomplete="off"
            />
            <div class="text-xs text-ink-faint mt-1">
              <template v-if="canSkipPat">
                PAT đã lưu trên server — để trống để dùng lại.
              </template>
              <template v-else>
                <a
                  :href="
                    gitlabPatUrl ||
                    `${gitlabBaseUrl}/-/user_settings/personal_access_tokens`
                  "
                  target="_blank"
                  rel="noopener"
                  class="text-accent font-medium"
                  >Tạo PAT</a
                >
                · scope <code>api</code>
              </template>
            </div>
          </a-form-item>
        </a-form>
        <a-button type="primary" block :loading="loading" @click="goStep2">
          {{ canSkipPat ? "Vào workspace" : "Tiếp tục" }}
        </a-button>
        <a-button
          v-if="returningUser && savedMemberships.length"
          block
          type="link"
          @click="setupNewProject"
          >Thêm / đổi project…</a-button
        >
      </div>

      <div v-show="step === 2" class="space-y-3">
        <a-alert
          v-if="savedMemberships.length"
          type="info"
          show-icon
          class="mb-1"
          message="Đã có workspace lưu sẵn"
          description="Chỉ cần setup khi join project mới. Có thể Back rồi Vào workspace."
        />
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
        <FolderPicker v-model:open="folderOpen" v-model="form.repoPath" />
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
