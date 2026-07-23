<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";
import { useRouter } from "vue-router";
import { message } from "ant-design-vue";
import { api } from "@/api/client";
import { useSessionStore, type Membership } from "@/stores/session";

const LAST_LOGIN_KEY = "flow_auto_work_last_login";

const router = useRouter();
const session = useSessionStore();

const mode = ref<"login" | "register">("login");
const loading = ref(false);
const errorText = ref("");

const form = reactive({
  username: "",
  password: "",
  password2: "",
  displayName: "",
});

onMounted(() => {
  try {
    const raw = localStorage.getItem(LAST_LOGIN_KEY);
    if (!raw) return;
    const last = JSON.parse(raw) as { username?: string };
    if (last?.username?.trim()) form.username = last.username.trim();
  } catch {
    /* ignore */
  }
});

function switchMode(next: "login" | "register") {
  mode.value = next;
  errorText.value = "";
  form.password = "";
  form.password2 = "";
}

type AuthRes = {
  user: { gitlabUsername?: string };
  memberships?: Membership[];
  activeProjectId?: string | null;
  accessToken: string;
  refreshToken: string;
  expiresIn?: number;
  accessExpiresAt?: number;
};

async function applyAuthAndGo(res: AuthRes) {
  const username = (
    res.user?.gitlabUsername || form.username.trim()
  ).replace(/^@/, "");

  session.setAuthTokens({
    accessToken: res.accessToken,
    refreshToken: res.refreshToken,
    expiresIn: res.expiresIn,
    accessExpiresAt: res.accessExpiresAt,
    username,
  });

  const projectId =
    res.activeProjectId || res.memberships?.[0]?.projectId || null;
  session.setMemberships(res.memberships || []);
  session.setSession({ username, projectId });

  try {
    await session.refreshMe();
  } catch {
    /* tokens already saved */
  }

  localStorage.setItem(
    LAST_LOGIN_KEY,
    JSON.stringify({
      username,
      projectId: session.session.projectId,
    }),
  );

  await router.push(
    session.session.projectId ? "/work" : "/settings/project",
  );
}

async function onLogin(e?: Event) {
  e?.preventDefault?.();
  if (loading.value) return;

  errorText.value = "";
  if (!form.username.trim() || !form.password) {
    errorText.value = "Nhập username và password";
    message.warning(errorText.value);
    return;
  }

  loading.value = true;
  try {
    const res = await api<AuthRes>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({
        username: form.username.trim(),
        password: form.password,
      }),
      skipRefresh: true,
    });
    message.success("Đăng nhập thành công");
    await applyAuthAndGo(res);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errorText.value = msg;
    message.error(msg);
  } finally {
    loading.value = false;
  }
}

async function onRegister(e?: Event) {
  e?.preventDefault?.();
  if (loading.value) return;

  errorText.value = "";
  if (!form.username.trim() || !form.password) {
    errorText.value = "Nhập username và password";
    message.warning(errorText.value);
    return;
  }
  if (form.password.length < 6) {
    errorText.value = "Password tối thiểu 6 ký tự";
    message.warning(errorText.value);
    return;
  }
  if (form.password !== form.password2) {
    errorText.value = "Password xác nhận không khớp";
    message.warning(errorText.value);
    return;
  }

  loading.value = true;
  try {
    const res = await api<AuthRes>("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({
        username: form.username.trim(),
        password: form.password,
        displayName: form.displayName.trim() || undefined,
      }),
      skipRefresh: true,
    });
    message.success("Đăng ký thành công");
    await applyAuthAndGo(res);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errorText.value = msg;
    message.error(msg);
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="min-h-screen flex items-center justify-center px-4 bg-slate-50">
    <div class="w-full max-w-md bg-white border border-slate-200 rounded-lg p-6 shadow-sm">
      <h1 class="text-xl font-semibold m-0 mb-4">Flow Auto Work</h1>

      <div class="flex gap-2 mb-5">
        <a-button
          block
          :type="mode === 'login' ? 'primary' : 'default'"
          @click="switchMode('login')"
        >
          Đăng nhập
        </a-button>
        <a-button
          block
          :type="mode === 'register' ? 'primary' : 'default'"
          @click="switchMode('register')"
        >
          Đăng ký
        </a-button>
      </div>

      <form
        v-if="mode === 'login'"
        class="space-y-4"
        @submit="onLogin"
      >
        <div>
          <label class="block text-sm text-slate-600 mb-1">Username</label>
          <a-input
            v-model:value="form.username"
            size="large"
            autocomplete="username"
            placeholder="Username"
          />
        </div>
        <div>
          <label class="block text-sm text-slate-600 mb-1">Password</label>
          <a-input-password
            v-model:value="form.password"
            size="large"
            autocomplete="current-password"
            placeholder="Password"
          />
        </div>
        <p v-if="errorText" class="text-sm text-red-600 m-0">{{ errorText }}</p>
        <a-button
          type="primary"
          block
          size="large"
          html-type="submit"
          :loading="loading"
          @click="onLogin"
        >
          Đăng nhập
        </a-button>
      </form>

      <form v-else class="space-y-4" @submit="onRegister">
        <div>
          <label class="block text-sm text-slate-600 mb-1">Username</label>
          <a-input
            v-model:value="form.username"
            size="large"
            autocomplete="username"
            placeholder="3–32 ký tự"
          />
        </div>
        <div>
          <label class="block text-sm text-slate-600 mb-1"
            >Display name (optional)</label
          >
          <a-input
            v-model:value="form.displayName"
            size="large"
            placeholder="Tên hiển thị"
          />
        </div>
        <div>
          <label class="block text-sm text-slate-600 mb-1">Password</label>
          <a-input-password
            v-model:value="form.password"
            size="large"
            autocomplete="new-password"
            placeholder="Tối thiểu 6 ký tự"
          />
        </div>
        <div>
          <label class="block text-sm text-slate-600 mb-1"
            >Confirm password</label
          >
          <a-input-password
            v-model:value="form.password2"
            size="large"
            autocomplete="new-password"
            placeholder="Nhập lại password"
          />
        </div>
        <p v-if="errorText" class="text-sm text-red-600 m-0">{{ errorText }}</p>
        <a-button
          type="primary"
          block
          size="large"
          html-type="submit"
          :loading="loading"
          @click="onRegister"
        >
          Tạo tài khoản
        </a-button>
      </form>
    </div>
  </div>
</template>
