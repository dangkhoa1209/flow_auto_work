<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import { message } from "ant-design-vue";
import { useRouter } from "vue-router";
import { useSessionStore } from "@/stores/session";
import { api } from "@/api/client";
import { API } from "@/api/endpoints";
import BaGitPatForm from "@/components/ba/BaGitPatForm.vue";
import { useBaGitPat } from "@/composables/useBaGitPat";

const session = useSessionStore();
const router = useRouter();
const { saveGitPat } = useBaGitPat();

const saving = ref(false);
const patFormRef = ref<InstanceType<typeof BaGitPatForm> | null>(null);

const googleBusy = ref(false);
const googleConfigured = ref(false);
const googleAuthorized = ref(false);
const googleEmail = ref<string | undefined>();

async function loadGoogleStatus() {
  try {
    const data = await api<{
      configured: boolean;
      authorized: boolean;
      email?: string;
    }>(API.ba.googleStatus);
    googleConfigured.value = Boolean(data.configured);
    googleAuthorized.value = Boolean(data.authorized);
    googleEmail.value = data.email;
  } catch {
    googleConfigured.value = false;
    googleAuthorized.value = false;
  }
}

async function authorizeGoogle() {
  googleBusy.value = true;
  try {
    const data = await api<{ authUrl: string }>(API.ba.googleAuthUrl);
    if (!data.authUrl) throw new Error("Không lấy được URL Google");
    const w = window.open(
      data.authUrl,
      "ba-google-oauth",
      "width=520,height=720",
    );
    if (!w) {
      message.warning("Cho phép popup để Authorize Google");
    }
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  } finally {
    googleBusy.value = false;
  }
}

async function revokeGoogle() {
  googleBusy.value = true;
  try {
    await api(API.ba.googleRevoke, { method: "POST" });
    message.success("Đã thu hồi Google");
    await loadGoogleStatus();
    await session.refreshMe();
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  } finally {
    googleBusy.value = false;
  }
}

function onGoogleMessage(ev: MessageEvent) {
  const data = ev.data as { type?: string; ok?: boolean } | null;
  if (!data || data.type !== "flow-google-oauth") return;
  void (async () => {
    await loadGoogleStatus();
    await session.refreshMe();
    if (data.ok) message.success("Đã ủy quyền Google — có thể đọc Docs/Sheets từ YC & chat");
    else message.error("Ủy quyền Google thất bại");
  })();
}

async function onSavePat(token: string) {
  saving.value = true;
  try {
    const ok = await saveGitPat(token);
    if (ok) patFormRef.value?.clearInput();
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  } finally {
    saving.value = false;
  }
}

async function logout() {
  await session.logout();
  message.success("Đã đăng xuất");
  await router.replace({ name: "login" });
}

onMounted(() => {
  void loadGoogleStatus();
  window.addEventListener("message", onGoogleMessage);
});

onUnmounted(() => {
  window.removeEventListener("message", onGoogleMessage);
});
</script>

<template>
  <div class="faw-settings h-full max-h-full min-h-0 overflow-y-auto overflow-x-hidden">
    <div class="faw-settings__inner max-w-xl">
      <header class="faw-settings__head">
        <h1 class="faw-settings__title">Settings</h1>
        <p class="text-[13px] text-[var(--app-muted)] m-0 mt-1">
          GitLab PAT, Google (Docs/Sheets), và tài khoản BA.
        </p>
      </header>

      <div class="faw-settings__panel space-y-6">
        <section
          class="rounded-xl border border-[var(--app-border)] bg-[var(--app-panel)] p-4"
        >
          <h2 class="text-sm font-semibold text-[var(--app-ink)] m-0 mb-3">
            GitLab PAT
          </h2>
          <BaGitPatForm
            ref="patFormRef"
            show-status
            :loading="saving"
            @save="onSavePat"
          />
        </section>

        <section
          class="rounded-xl border border-[var(--app-border)] bg-[var(--app-panel)] p-4 space-y-3"
        >
          <h2 class="text-sm font-semibold text-[var(--app-ink)] m-0">
            Google Docs / Sheets / Drive
          </h2>
          <p class="text-[12px] text-[var(--app-muted)] m-0">
            Cho phép đọc link Google Docs, Sheets, Excel trên Drive khi dán vào
            YC gốc hoặc chat Phân tích YC (#issue GitLab dùng PAT project).
          </p>
          <div class="text-sm">
            <template v-if="!googleConfigured">
              <span class="text-orange-600">Server chưa cấu hình Google OAuth</span>
            </template>
            <template v-else-if="googleAuthorized">
              Đã ủy quyền
              <span v-if="googleEmail" class="text-[var(--app-muted)]">
                · {{ googleEmail }}
              </span>
            </template>
            <template v-else>
              <span class="text-[var(--app-muted)]">Chưa ủy quyền</span>
            </template>
          </div>
          <div class="flex flex-wrap gap-2">
            <button
              type="button"
              class="faw-btn faw-btn--run"
              :disabled="!googleConfigured || googleBusy"
              @click="authorizeGoogle"
            >
              {{ googleAuthorized ? "Ủy quyền lại" : "Authorize Google" }}
            </button>
            <button
              v-if="googleAuthorized"
              type="button"
              class="faw-btn"
              :disabled="googleBusy"
              @click="revokeGoogle"
            >
              Thu hồi
            </button>
          </div>
        </section>

        <section
          class="rounded-xl border border-[var(--app-border)] bg-[var(--app-panel)] p-4 space-y-3"
        >
          <h2 class="text-sm font-semibold text-[var(--app-ink)] m-0">
            Tài khoản
          </h2>
          <a-descriptions
            bordered
            size="small"
            :column="1"
            class="faw-settings-desc"
          >
            <a-descriptions-item label="Username">
              @{{ session.me?.gitlabUsername || session.session.username }}
            </a-descriptions-item>
          </a-descriptions>
          <button type="button" class="faw-btn faw-btn--danger" @click="logout">
            Đăng xuất
          </button>
        </section>
      </div>
    </div>
  </div>
</template>
