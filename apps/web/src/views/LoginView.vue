<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { message } from "ant-design-vue";
import type { AuthTokensResponse } from "@/api/authApi";
import { authApi } from "@/api/authApi";
import { recoverAuthRefreshLocks } from "@/api/http";
import { LAST_LOGIN_KEY } from "@/api/tokenStorage";
import { useAuthStore } from "@/stores/auth";
import { useSessionStore, type Membership } from "@/stores/session";
import { isPathAllowed, resolveHomeRoute } from "@/utils/routeAccess";

const router = useRouter();
const route = useRoute();
const auth = useAuthStore();
const session = useSessionStore();

const mode = ref<"login" | "register" | "forgot">("login");
const loading = ref(false);
const errorText = ref("");
const forgotSent = ref(false);
const forgotMessage = ref("");
const usernameInputRef = ref<{ focus?: () => void } | null>(null);

/** Glow follows pointer (%, relative to login root). */
const glowX = ref(50);
const glowY = ref(28);
const glowActive = ref(false);
const reduceMotion = ref(false);
/** Form slide direction + brief panel pulse on mode change. */
const formDir = ref<"fwd" | "back">("fwd");
const modeMorphing = ref(false);
const modeBlooming = ref(false);
const stageRef = ref<HTMLElement | null>(null);
const stageHeight = ref<string>("auto");
const segRipples = ref<
  { id: number; x: number; y: number; side: "login" | "register" }[]
>([]);
let morphTimer: ReturnType<typeof setTimeout> | null = null;
let bloomTimer: ReturnType<typeof setTimeout> | null = null;
let stageHeightTimer: ReturnType<typeof setTimeout> | null = null;
let rippleId = 0;

const modeTransitionName = computed(() =>
  formDir.value === "fwd" ? "faw-login-fwd" : "faw-login-back",
);

const stageStyle = computed(() =>
  stageHeight.value === "auto" ? undefined : { height: stageHeight.value },
);

const MODE_ORDER = { login: 0, register: 1, forgot: 2 } as const;

const form = reactive({
  username: "",
  password: "",
  password2: "",
  displayName: "",
  note: "",
  role: "dev" as "dev" | "qc" | "pd" | "ba" | "devops",
});

const roleOptions = [
  { value: "dev" as const, short: "Dev" },
  { value: "ba" as const, short: "BA" },
  { value: "pd" as const, short: "PD" },
  { value: "qc" as const, short: "QC" },
  { value: "devops" as const, short: "Build" },
];

/** Only allow same-origin relative paths (block open redirects). */
function safeRedirectTarget(): string | null {
  const raw = route.query.redirect;
  const path = Array.isArray(raw) ? raw[0] : raw;
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")) {
    return null;
  }
  if (path.startsWith("/login")) return null;
  return path;
}

function postAuthPath(): string {
  const access = {
    isAdmin: session.isAdmin,
    isDevopsAudience: session.isDevopsAudience,
    isQcAudience: session.isQcAudience,
    canAccessWork: session.canAccessWork,
    canAccessBa: session.canAccessBa,
    canAccessQc: session.canAccessQc,
    canAccessDevops: session.canAccessDevops,
  };
  const redirect = safeRedirectTarget();
  if (redirect && isPathAllowed(redirect, access)) return redirect;
  return resolveHomeRoute(access);
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

function onLoginVisible() {
  if (document.visibilityState !== "visible") return;
  recoverAuthRefreshLocks();
  // Mobile Home resume can leave a hung Sign-in attempt (button stuck disabled).
  if (loading.value) loading.value = false;
}

function focusUsername() {
  nextTick(() => {
    usernameInputRef.value?.focus?.();
  });
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
    if (raw) {
      const last = JSON.parse(raw) as { username?: string };
      if (last?.username?.trim()) form.username = last.username.trim();
    }
  } catch {
    /* ignore */
  }
  document.addEventListener("visibilitychange", onLoginVisible);
  focusUsername();
});

onUnmounted(() => {
  document.removeEventListener("visibilitychange", onLoginVisible);
  if (morphTimer) clearTimeout(morphTimer);
  if (bloomTimer) clearTimeout(bloomTimer);
  if (stageHeightTimer) clearTimeout(stageHeightTimer);
});

function lockStageHeight() {
  const stage = stageRef.value;
  if (!stage || reduceMotion.value) return;
  stageHeight.value = `${stage.offsetHeight}px`;
}

function onStageBeforeLeave(el: Element) {
  if (reduceMotion.value) return;
  const h = (el as HTMLElement).offsetHeight;
  if (h > 0) stageHeight.value = `${h}px`;
}

function onStageEnter(el: Element) {
  if (reduceMotion.value) {
    stageHeight.value = "auto";
    return;
  }
  const target = (el as HTMLElement).offsetHeight;
  // Keep prior height one frame, then morph to the incoming form.
  requestAnimationFrame(() => {
    stageHeight.value = `${Math.max(target, 1)}px`;
  });
}

function onStageAfterEnter() {
  if (reduceMotion.value) {
    stageHeight.value = "auto";
    return;
  }
  if (stageHeightTimer) clearTimeout(stageHeightTimer);
  stageHeightTimer = setTimeout(() => {
    stageHeight.value = "auto";
    stageHeightTimer = null;
  }, 420);
}

function spawnSegRipple(
  e: MouseEvent | PointerEvent,
  side: "login" | "register",
) {
  if (reduceMotion.value) return;
  const btn = e.currentTarget as HTMLElement | null;
  if (!btn) return;
  const rect = btn.getBoundingClientRect();
  const id = ++rippleId;
  segRipples.value = [
    ...segRipples.value.slice(-3),
    {
      id,
      side,
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    },
  ];
  window.setTimeout(() => {
    segRipples.value = segRipples.value.filter((r) => r.id !== id);
  }, 520);
}

function switchMode(next: "login" | "register" | "forgot") {
  if (mode.value === next) return;
  formDir.value =
    MODE_ORDER[next] >= MODE_ORDER[mode.value] ? "fwd" : "back";
  lockStageHeight();
  mode.value = next;
  errorText.value = "";
  forgotSent.value = false;
  forgotMessage.value = "";
  form.password = "";
  form.password2 = "";
  if (next !== "forgot") form.note = "";
  if (!reduceMotion.value) {
    modeMorphing.value = true;
    modeBlooming.value = true;
    if (morphTimer) clearTimeout(morphTimer);
    if (bloomTimer) clearTimeout(bloomTimer);
    morphTimer = setTimeout(() => {
      modeMorphing.value = false;
      morphTimer = null;
    }, 560);
    bloomTimer = setTimeout(() => {
      modeBlooming.value = false;
      bloomTimer = null;
    }, 680);
  }
  focusUsername();
}

function selectRole(value: typeof form.role) {
  if (loading.value) return;
  form.role = value;
}

function normalizeUsername(raw: string) {
  return raw.trim().replace(/^@+/, "");
}

async function applyAuthAndGo(res: AuthTokensResponse) {
  recoverAuthRefreshLocks();
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
  if (res.user) {
    session.setMe({
      gitlabUsername: res.user.gitlabUsername || username,
      ...res.user,
    });
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

  const target = postAuthPath();
  await router.replace(target);
  if (router.currentRoute.value.name === "login") {
    // Stale expire / guard race — retry once after clearing hung refresh locks.
    recoverAuthRefreshLocks();
    await router.replace(target);
  }
  if (router.currentRoute.value.name === "login") {
    throw new Error(
      "Signed in but session was cleared — please try again",
    );
  }
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
  recoverAuthRefreshLocks();
  try {
    const res = await auth.login(username, form.password);
    await applyAuthAndGo(res);
    message.success("Signed in");
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
      role: form.role,
    });
    await applyAuthAndGo(res);
    message.success("Account created");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errorText.value = msg;
    message.error(msg);
  } finally {
    loading.value = false;
  }
}

async function onForgotPassword(e?: Event) {
  e?.preventDefault?.();
  if (loading.value) return;

  errorText.value = "";
  forgotSent.value = false;
  forgotMessage.value = "";
  const username = normalizeUsername(form.username);
  if (!username) {
    errorText.value = "Enter your username";
    message.warning(errorText.value);
    return;
  }
  form.username = username;

  loading.value = true;
  try {
    const res = await authApi.forgotPassword({
      username,
      note: form.note.trim() || undefined,
    });
    forgotSent.value = true;
    forgotMessage.value =
      res.message ||
      "If that account exists, your workspace admin will see a reset request.";
    message.success("Request sent");
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
  <div
    class="faw-login"
    :class="{
      'is-blooming': modeBlooming,
      [`is-mode-${mode}`]: true,
      [`is-dir-${formDir}`]: modeMorphing,
    }"
    @pointermove="onPointerMove"
    @pointerleave="onPointerLeave"
  >
    <div class="faw-login__grid" aria-hidden="true" />
    <div
      class="faw-login__glow"
      :class="{ 'is-follow': glowActive && !reduceMotion }"
      aria-hidden="true"
      :style="{
        left: `${glowX}%`,
        top: `${glowY}%`,
      }"
    />
    <div class="faw-login__bloom" aria-hidden="true" />

    <div class="faw-login__shell">
      <aside
        class="faw-login__brand"
        :class="`is-mode-${mode}`"
      >
        <img
          class="faw-login__logo"
          src="/logo.svg"
          alt="Flow Auto WorkBench"
          width="280"
          height="64"
          draggable="false"
        />
        <p class="faw-login__tagline">
          From ticket to commit — steered by you
        </p>
        <p class="faw-login__hint">
          One workspace for Code, ChatBox, and Build.
        </p>
      </aside>

      <div class="faw-login__main">
        <div
          class="faw-login__panel"
          :class="{
            'is-morphing': modeMorphing,
            'is-tilt-fwd': modeMorphing && formDir === 'fwd',
            'is-tilt-back': modeMorphing && formDir === 'back',
          }"
        >
          <div
            v-if="mode !== 'forgot'"
            class="faw-seg faw-login__seg"
            role="tablist"
            aria-label="Auth mode"
          >
            <span
              class="faw-login__seg-thumb"
              :class="{ 'is-register': mode === 'register' }"
              aria-hidden="true"
            />
            <button
              type="button"
              class="faw-seg__btn"
              :class="{ active: mode === 'login' }"
              role="tab"
              :aria-selected="mode === 'login'"
              :disabled="loading"
              @click="spawnSegRipple($event, 'login'); switchMode('login')"
            >
              <span
                v-for="r in segRipples.filter((x) => x.side === 'login')"
                :key="r.id"
                class="faw-login__seg-ripple"
                :style="{ left: `${r.x}px`, top: `${r.y}px` }"
                aria-hidden="true"
              />
              Sign in
            </button>
            <button
              type="button"
              class="faw-seg__btn"
              :class="{ active: mode === 'register' }"
              role="tab"
              :aria-selected="mode === 'register'"
              :disabled="loading"
              @click="spawnSegRipple($event, 'register'); switchMode('register')"
            >
              <span
                v-for="r in segRipples.filter((x) => x.side === 'register')"
                :key="r.id"
                class="faw-login__seg-ripple"
                :style="{ left: `${r.x}px`, top: `${r.y}px` }"
                aria-hidden="true"
              />
              Register
            </button>
          </div>

          <div
            ref="stageRef"
            class="faw-login__stage"
            :style="stageStyle"
          >
          <Transition
            :name="modeTransitionName"
            mode="out-in"
            :css="!reduceMotion"
            @before-leave="onStageBeforeLeave"
            @enter="onStageEnter"
            @after-enter="onStageAfterEnter"
          >
            <form
              v-if="mode === 'login'"
              key="login"
              class="faw-login__form"
              :aria-busy="loading"
              @submit.prevent="onLogin"
            >
              <label class="faw-login__field">
                <span>Username or email</span>
                <a-input
                  ref="usernameInputRef"
                  v-model:value="form.username"
                  size="large"
                  autocomplete="username"
                  placeholder="username or you@company.com"
                  :disabled="loading"
                  :aria-invalid="!!errorText"
                  @pressEnter="onLogin"
                />
              </label>
              <label class="faw-login__field">
                <span>Password</span>
                <a-input-password
                  v-model:value="form.password"
                  size="large"
                  autocomplete="current-password"
                  placeholder="Password"
                  :disabled="loading"
                  :aria-invalid="!!errorText"
                  @pressEnter="onLogin"
                />
              </label>
              <p
                v-if="errorText"
                id="login-error"
                class="faw-login__error"
                role="alert"
                aria-live="assertive"
              >
                {{ errorText }}
              </p>
              <button
                type="submit"
                class="faw-btn faw-btn--run faw-login__submit"
                :disabled="loading"
                :aria-busy="loading"
              >
                <span
                  v-if="loading"
                  class="faw-login__spinner"
                  aria-hidden="true"
                />
                <span class="faw-login__cta-text">
                  <Transition name="faw-login-cta" mode="out-in">
                    <span :key="loading ? 'busy' : 'idle'">
                      {{ loading ? "Signing in…" : "Sign in" }}
                    </span>
                  </Transition>
                </span>
              </button>
              <button
                type="button"
                class="faw-login__forgot-link"
                :disabled="loading"
                @click="switchMode('forgot')"
              >
                Forgot password?
              </button>
            </form>

            <form
              v-else-if="mode === 'forgot'"
              key="forgot"
              class="faw-login__form"
              :aria-busy="loading"
              @submit.prevent="onForgotPassword"
            >
              <div class="faw-login__forgot-head">
                <h2 class="faw-login__forgot-title">Reset password</h2>
                <p class="faw-login__forgot-copy">
                  Passwords are reset by a workspace admin. Send a request with
                  your username — they will generate a new password and share it
                  with you.
                </p>
              </div>

              <template v-if="!forgotSent">
                <label class="faw-login__field">
                  <span>Username</span>
                  <a-input
                    ref="usernameInputRef"
                    v-model:value="form.username"
                    size="large"
                    autocomplete="username"
                    placeholder="Your username"
                    :disabled="loading"
                    :aria-invalid="!!errorText"
                  />
                </label>
                <label class="faw-login__field">
                  <span>Note for admin <em>(optional)</em></span>
                  <a-textarea
                    v-model:value="form.note"
                    :rows="2"
                    :maxlength="280"
                    placeholder="How can they reach you?"
                    :disabled="loading"
                  />
                </label>
                <p
                  v-if="errorText"
                  id="forgot-error"
                  class="faw-login__error"
                  role="alert"
                  aria-live="assertive"
                >
                  {{ errorText }}
                </p>
                <button
                  type="submit"
                  class="faw-btn faw-btn--run faw-login__submit"
                  :disabled="loading"
                  :aria-busy="loading"
                >
                  <span
                    v-if="loading"
                    class="faw-login__spinner"
                    aria-hidden="true"
                  />
                  <span class="faw-login__cta-text">
                    <Transition name="faw-login-cta" mode="out-in">
                      <span :key="loading ? 'busy' : 'idle'">
                        {{ loading ? "Sending…" : "Ask admin to reset" }}
                      </span>
                    </Transition>
                  </span>
                </button>
              </template>

              <div
                v-else
                class="faw-login__forgot-ok"
                role="status"
                aria-live="polite"
              >
                <p class="faw-login__forgot-ok-title">Request sent</p>
                <p class="faw-login__forgot-ok-body">{{ forgotMessage }}</p>
              </div>

              <button
                type="button"
                class="faw-login__back"
                :disabled="loading"
                @click="switchMode('login')"
              >
                ← Back to Sign in
              </button>
            </form>

            <form
              v-else
              key="register"
              class="faw-login__form"
              :aria-busy="loading"
              @submit.prevent="onRegister"
            >
              <label class="faw-login__field">
                <span>Username or email</span>
                <a-input
                  ref="usernameInputRef"
                  v-model:value="form.username"
                  size="large"
                  autocomplete="username"
                  placeholder="username or you@company.com"
                  :disabled="loading"
                  :aria-invalid="!!errorText"
                />
              </label>
              <label class="faw-login__field">
                <span>Display name <em>(optional)</em></span>
                <a-input
                  v-model:value="form.displayName"
                  size="large"
                  autocomplete="nickname"
                  placeholder="How you appear in the bench"
                  :disabled="loading"
                />
              </label>

              <fieldset class="faw-login__group">
                <legend class="faw-login__group-label">Role</legend>
                <div
                  class="faw-login__roles"
                  role="radiogroup"
                  aria-label="Workspace role"
                >
                  <button
                    v-for="(opt, idx) in roleOptions"
                    :key="opt.value"
                    type="button"
                    class="faw-login__role"
                    role="radio"
                    :aria-checked="form.role === opt.value"
                    :class="{ active: form.role === opt.value }"
                    :style="{ '--role-i': String(idx) }"
                    :disabled="loading"
                    @click="selectRole(opt.value)"
                  >
                    {{ opt.short }}
                  </button>
                </div>
              </fieldset>

              <label class="faw-login__field">
                <span>Password</span>
                <a-input-password
                  v-model:value="form.password"
                  size="large"
                  autocomplete="new-password"
                  placeholder="At least 6 characters"
                  :disabled="loading"
                  :aria-invalid="!!errorText"
                />
              </label>
              <label class="faw-login__field">
                <span>Confirm password</span>
                <a-input-password
                  v-model:value="form.password2"
                  size="large"
                  autocomplete="new-password"
                  placeholder="Re-enter password"
                  :disabled="loading"
                  :aria-invalid="!!errorText"
                  @pressEnter="onRegister"
                />
              </label>

              <p
                v-if="errorText"
                id="register-error"
                class="faw-login__error"
                role="alert"
                aria-live="assertive"
              >
                {{ errorText }}
              </p>
              <button
                type="submit"
                class="faw-btn faw-btn--run faw-login__submit"
                :disabled="loading"
                :aria-busy="loading"
              >
                <span
                  v-if="loading"
                  class="faw-login__spinner"
                  aria-hidden="true"
                />
                <span class="faw-login__cta-text">
                  <Transition name="faw-login-cta" mode="out-in">
                    <span :key="loading ? 'busy' : 'idle'">
                      {{ loading ? "Creating…" : "Create account" }}
                    </span>
                  </Transition>
                </span>
              </button>
            </form>
          </Transition>
          </div>
        </div>

        <p class="faw-login__foot">
          One account · all of Flow Auto
        </p>
      </div>
    </div>
  </div>
</template>
