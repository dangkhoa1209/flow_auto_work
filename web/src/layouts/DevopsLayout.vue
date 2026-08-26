<script setup lang="ts">
import { computed, ref } from "vue";
import { useRouter, RouterLink, RouterView } from "vue-router";
import { message } from "ant-design-vue";
import type { BuildJob } from "@/api/devopsApi";
import { useSessionStore } from "@/stores/session";
import { useDevopsStore, type DevopsTab } from "@/stores/devops";
import { useThemeStore } from "@/stores/theme";

const router = useRouter();
const session = useSessionStore();
const devops = useDevopsStore();
const themeStore = useThemeStore();

const queuePopOpen = ref(false);

const tabs: Array<{ key: DevopsTab; label: string }> = [
  { key: "build", label: "Build" },
  { key: "history", label: "History" },
  { key: "config", label: "Cấu hình" },
];

const runningJob = computed(
  () => devops.builds.find((b) => b.id === devops.queue.currentBuildId) || null,
);

const workerLabel = computed(() => {
  if (devops.queue.shuttingDown) return "SHUTTING DOWN";
  if (runningJob.value) return `RUNNING: ${runningJob.value.scriptLabel}`;
  return "IDLE";
});

const idleDot = computed(() => (devops.queue.running ? "wip" : "idle"));

const queuedJobs = computed(() =>
  devops.queue.queuedIds
    .map((id, i) => ({
      pos: i + 1,
      job: devops.builds.find((b) => b.id === id),
    }))
    .filter((row): row is { pos: number; job: BuildJob } => Boolean(row.job)),
);

async function onSelectQueued(id: string) {
  queuePopOpen.value = false;
  devops.activeTab = "build";
  await devops.selectBuild(id);
}

async function onCancelQueued(id: string) {
  try {
    await devops.cancel(id);
    message.success("Cancel requested");
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  }
}

async function logout() {
  await session.logout();
  message.success("Signed out");
  await router.push({ name: "login" });
}
</script>

<template>
  <div
    class="h-[100dvh] max-h-[100dvh] flex flex-col overflow-hidden bg-[var(--app-bg)]"
  >
    <header class="faw-topbar faw-topbar--devops">
      <RouterLink
        to="/devops"
        class="faw-brand"
        title="Flow Auto WorkBench — Devops"
      >
        <img
          class="faw-brand__logo faw-brand__logo--full"
          src="/logo.svg"
          alt="Flow Auto WorkBench"
          width="148"
          height="33"
          draggable="false"
        />
        <img
          class="faw-brand__logo faw-brand__logo--mark"
          src="/favicon.svg"
          alt="FLOW.AUTO"
          width="28"
          height="28"
          draggable="false"
        />
      </RouterLink>

      <nav class="faw-seg" role="tablist">
        <button
          v-for="t in tabs"
          :key="t.key"
          type="button"
          class="faw-seg__btn"
          :class="{ active: devops.activeTab === t.key }"
          role="tab"
          :aria-selected="devops.activeTab === t.key"
          @click="devops.activeTab = t.key"
        >
          {{ t.label }}
        </button>
      </nav>

      <div class="faw-topbar__spacer" />

      <div class="faw-topbar__right">
        <span class="faw-idle" :title="workerLabel">
          <span class="faw-idle__dot" :class="idleDot" />
          {{ workerLabel }}
        </span>

        <a-popover
          v-model:open="queuePopOpen"
          trigger="click"
          placement="bottomRight"
        >
          <template #content>
            <div class="faw-dev-queue-pop">
              <p v-if="!queuedJobs.length" class="faw-dev-queue-pop__empty">
                Queue trống
              </p>
              <div
                v-for="row in queuedJobs"
                :key="row.job.id"
                class="faw-dev-queue-pop__row"
              >
                <span class="faw-dev-pos">#{{ row.pos }}</span>
                <button
                  type="button"
                  class="faw-dev-queue-pop__label"
                  @click="onSelectQueued(row.job.id)"
                >
                  {{ row.job.scriptLabel }}
                </button>
                <a-popconfirm
                  title="Xóa job này khỏi queue?"
                  ok-text="Hủy job"
                  cancel-text="Giữ"
                  ok-type="danger"
                  @confirm="onCancelQueued(row.job.id)"
                >
                  <button type="button" class="faw-dev-queue-pop__cancel">
                    Hủy
                  </button>
                </a-popconfirm>
              </div>
            </div>
          </template>
          <button
            type="button"
            class="faw-btn"
            title="Xem hàng đợi build"
          >
            Queue: {{ devops.queue.queued }}
            {{ devops.queue.queued === 1 ? "job" : "jobs" }}
          </button>
        </a-popover>

        <RouterLink v-if="session.isAdmin" to="/admin" class="faw-btn">
          Admin
        </RouterLink>
        <RouterLink
          v-if="session.me?.roles?.includes('dev')"
          to="/work"
          class="faw-btn"
        >
          Work
        </RouterLink>

        <div class="faw-user-chip">
          <span class="faw-avatar" />
          @{{ session.me?.gitlabUsername || session.session.username }}
        </div>

        <button
          type="button"
          class="faw-icon-btn"
          :title="
            themeStore.mode === 'dark'
              ? 'Switch to light mode'
              : 'Switch to dark mode'
          "
          @click="themeStore.toggle()"
        >
          {{ themeStore.mode === "dark" ? "☀" : "☾" }}
        </button>

        <button type="button" class="faw-btn" title="Logout" @click="logout">
          Logout
        </button>
      </div>
    </header>

    <main class="flex-1 min-h-0 overflow-hidden">
      <RouterView />
    </main>
  </div>
</template>
