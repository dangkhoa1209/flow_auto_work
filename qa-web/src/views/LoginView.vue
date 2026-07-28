<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { message } from "ant-design-vue";
import type { AuthTokensResponse } from "@/api/authApi";
import { LAST_LOGIN_KEY } from "@/api/tokenStorage";
import { useAuthStore } from "@/stores/auth";
import { useSessionStore, type Membership } from "@/stores/session";

const router = useRouter();
const route = useRoute();
const auth = useAuthStore();
const session = useSessionStore();

const mode = ref<"login" | "register">("login");
const loading = ref(false);
const errorText = ref("");

const glowX = ref(50);
const glowY = ref(28);
const glowActive = ref(false);
const reduceMotion = ref(false);

const form = reactive({
  username: "",
  password: "",
  password2: "",
  displayName: "",
});

function safeRedirectTarget(): string | null {
  const raw = route.query.redirect;
  const path = Array.isArray(raw) ? raw[0] : raw;
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")) {
    return null;
  }
  if (path.startsWith("/login")) return null;
  return path;
}

function postAuthPath(projectId: string | null): string {
  return safeRedirectTarget() || (projectId ? "/trigger" : "/config");
}

function onPointerMove(e: PointerEvent) {
  if (reduceMotion.value) return;
  const el = e.currentTarget as HTMLElement | null;
  if (!el) return;
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return;
  glowX.value = ((e.clientX - rect.left) / rect.width) * 100;
  glowY.value = ((e.clientY - rect.top) / rect.height) * 100;
  glowActive.value = true;
}

function onPointerLeave() {
  glowActive.value = false;
}

onMounted(() => {
  try {
    reduceMotion.value = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
  } catch {
    /* ignore */
  }
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

function normalizeUsername(raw: string) {
  return raw.trim().replace(/^@+/, "");
}

async function applyAuthAndGo(res: AuthTokensResponse) {
  const username = normalizeUsername(
    res.user?.gitlabUsername || form.username,
  );

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
  if (projectId) {
    session.selectProject(projectId);
  }

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

  await router.replace(postAuthPath(session.session.projectId));
}

async function onLogin(e?: Event) {
  e?.preventDefault?.();
  if (loading.value) return;

  errorText.value = "";
  const username = normalizeUsername(form.username);
  if (!username || !form.password) {
    errorText.value = "Enter username and password";
    message.warning(errorText.value);
    return;
  }
  form.username = username;

  loading.value = true;
  try {
    const res = await auth.login(username, form.password);
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
  const username = normalizeUsername(form.username);
  if (!username || !form.password) {
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
  form.username = username;

  loading.value = true;
  try {
    const res = await auth.register({
      username,
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
  <div class="faw-login" @pointermove="onPointerMove" @pointerleave="onPointerLeave">
    <div class="faw-login__grid" aria-hidden="true" />
    <div class="faw-login__glow" :class="{ 'is-follow': glowActive && !reduceMotion }" aria-hidden="true" :style="{
      left: `${glowX}%`,
      top: `${glowY}%`,
    }" />

    <div class="faw-login__shell">
      <header class="faw-login__brand">
        <img class="faw-login__logo" src="/logo.svg" alt="Flow Auto WorkBench" width="248" height="56"
          draggable="false" />
      </header>

      <p class="faw-login__tagline">
        QA Agents WorkBench
      </p>

      <div class="faw-login__panel">
        <div class="faw-seg faw-login__seg" role="tablist">
          <button type="button" class="faw-seg__btn" :class="{ active: mode === 'login' }" role="tab"
            :aria-selected="mode === 'login'" @click="switchMode('login')">
            Sign in
          </button>
          <button type="button" class="faw-seg__btn" :class="{ active: mode === 'register' }" role="tab"
            :aria-selected="mode === 'register'" @click="switchMode('register')">
            Register
          </button>
        </div>

        <form v-if="mode === 'login'" class="faw-login__form" @submit.prevent="onLogin">
          <label class="faw-login__field">
            <span>Username</span>
            <a-input v-model:value="form.username" autocomplete="username" placeholder="@username" />
          </label>
          <label class="faw-login__field">
            <span>Password</span>
            <a-input-password v-model:value="form.password" autocomplete="current-password" placeholder="Password" />
          </label>
          <p v-if="errorText" class="faw-login__error" role="alert">
            {{ errorText }}
          </p>
          <button type="submit" class="faw-btn faw-btn--run faw-login__submit" :disabled="loading">
            {{ loading ? "Signing in…" : "Sign in" }}
          </button>
        </form>

        <form v-else class="faw-login__form" @submit.prevent="onRegister">
          <label class="faw-login__field">
            <span>Username</span>
            <a-input v-model:value="form.username" autocomplete="username" placeholder="3–32 characters" />
          </label>
          <label class="faw-login__field">
            <span>Display name <em>(optional)</em></span>
            <a-input v-model:value="form.displayName" placeholder="How you appear in the bench" />
          </label>
          <label class="faw-login__field">
            <span>Password</span>
            <a-input-password v-model:value="form.password" autocomplete="new-password"
              placeholder="At least 6 characters" />
          </label>
          <label class="faw-login__field">
            <span>Confirm password</span>
            <a-input-password v-model:value="form.password2" autocomplete="new-password"
              placeholder="Re-enter password" />
          </label>
          <p v-if="errorText" class="faw-login__error" role="alert">
            {{ errorText }}
          </p>
          <button type="submit" class="faw-btn faw-btn--run faw-login__submit" :disabled="loading">
            {{ loading ? "Creating…" : "Create account" }}
          </button>
        </form>
      </div>

      <p class="faw-login__foot">
        Same account as your Flow Auto workspace
      </p>
    </div>
  </div>
</template>
