<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";
import { useRouter } from "vue-router";
import { message } from "ant-design-vue";
import type { AuthTokensResponse } from "@/api/authApi";
import { LAST_LOGIN_KEY } from "@/api/tokenStorage";
import { useAuthStore } from "@/stores/auth";
import { useSessionStore, type Membership } from "@/stores/session";

const router = useRouter();
const auth = useAuthStore();
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

async function applyAuthAndGo(res: AuthTokensResponse) {
  const username = (
    res.user?.gitlabUsername || form.username.trim()
  ).replace(/^@/, "");

  const projectId =
    res.activeProjectId || res.memberships?.[0]?.projectId || null;

  auth.setTokens({
    accessToken: res.accessToken,
    refreshToken: res.refreshToken,
    expiresIn: res.expiresIn,
    accessExpiresAt: res.accessExpiresAt,
    username,
    projectId,
    user: res.user,
  });

  session.setMemberships((res.memberships || []) as Membership[]);
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
    errorText.value = "Enter username and password";
    message.warning(errorText.value);
    return;
  }

  loading.value = true;
  try {
    const res = await auth.login(form.username.trim(), form.password);
    message.success("Signed in");
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
    errorText.value = "Enter username and password";
    message.warning(errorText.value);
    return;
  }
  if (form.password.length < 6) {
    errorText.value = "Password must be at least 6 characters";
    message.warning(errorText.value);
    return;
  }
  if (form.password !== form.password2) {
    errorText.value = "Passwords do not match";
    message.warning(errorText.value);
    return;
  }

  loading.value = true;
  try {
    const res = await auth.register({
      username: form.username.trim(),
      password: form.password,
      displayName: form.displayName.trim() || undefined,
    });
    message.success("Account created");
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
      <div class="mb-5 flex justify-center">
        <img
          src="/logo.svg"
          alt="Flow Auto WorkBench"
          class="h-12 w-auto max-w-full object-contain"
          width="240"
          height="60"
        />
      </div>

      <div class="flex gap-2 mb-5">
        <a-button
          block
          :type="mode === 'login' ? 'primary' : 'default'"
          @click="switchMode('login')"
        >
          Sign in
        </a-button>
        <a-button
          block
          :type="mode === 'register' ? 'primary' : 'default'"
          @click="switchMode('register')"
        >
          Register
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
          Sign in
        </a-button>
      </form>

      <form v-else class="space-y-4" @submit="onRegister">
        <div>
          <label class="block text-sm text-slate-600 mb-1">Username</label>
          <a-input
            v-model:value="form.username"
            size="large"
            autocomplete="username"
            placeholder="3–32 characters"
          />
        </div>
        <div>
          <label class="block text-sm text-slate-600 mb-1"
            >Display name (optional)</label
          >
          <a-input
            v-model:value="form.displayName"
            size="large"
            placeholder="Display name"
          />
        </div>
        <div>
          <label class="block text-sm text-slate-600 mb-1">Password</label>
          <a-input-password
            v-model:value="form.password"
            size="large"
            autocomplete="new-password"
            placeholder="At least 6 characters"
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
            placeholder="Re-enter password"
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
          Create account
        </a-button>
      </form>
    </div>
  </div>
</template>
