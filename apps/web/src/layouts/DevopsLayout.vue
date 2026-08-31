<script setup lang="ts">
import { computed, ref } from "vue";
import { useRouter, RouterLink, RouterView } from "vue-router";
import { message } from "ant-design-vue";
import type { BuildJob } from "@/api/devopsApi";
import AppTopbarRight from "@/components/layout/AppTopbarRight.vue";
import AppSwitcher from "@/components/layout/AppSwitcher.vue";
import { useSessionStore } from "@/stores/session";
import { useDevopsStore, type DevopsTab } from "@/stores/devops";
import MobileBottomNav from "@/components/MobileBottomNav.vue";

const router = useRouter();
const session = useSessionStore();
const devops = useDevopsStore();

const queuePopOpen = ref(false);

const tabs: Array<{ key: DevopsTab; label: string }> = [
  { key: "build", label: "Build" },
  { key: "history", label: "History" },
  { key: "config", label: "Cấu hình" },
];

const inSettings = computed(() =>
  router.currentRoute.value.path.startsWith("/devops/settings"),
);

const runningJob = computed(
  () => devops.builds.find((b) => b.id === devops.queue.currentBuildId) || null,
);

const workerLabel = computed(() => {
  if (devops.queue.shuttingDown) return "SHUTTING DOWN";
  if (runningJob.value) {
    return `RUNNING: ${runningJob.value.scriptLabel} (@${runningJob.value.triggeredBy})`;
  }
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
</script>

<template>
  <div
    class="faw-app-shell h-[100dvh] max-h-[100dvh] flex flex-col overflow-hidden bg-[var(--app-bg)]"
  >
    <header class="faw-topbar faw-topbar--devops">
      <RouterLink
        to="/devops"
        class="faw-brand"
        title="Flow Auto WorkBench — Build"
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

      <AppSwitcher />

      <nav v-if="!inSettings" class="faw-seg hidden lg:flex" role="tablist">
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

      <AppTopbarRight settings-to="/devops/settings/account" class="hidden lg:contents">
        <template #status>
          <span class="faw-idle" :title="workerLabel">
            <span class="faw-idle__dot" :class="idleDot" />
            {{ workerLabel }}
          </span>
        </template>
        <template #extra>
          <a-popover
            v-if="!inSettings"
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
                    <span class="block truncate">{{ row.job.scriptLabel }}</span>
                    <span class="faw-dev-queue-pop__meta"
                      >@{{ row.job.triggeredBy }}</span
                    >
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
            <button type="button" class="faw-btn" title="Xem hàng đợi build">
              Queue: {{ devops.queue.queued }}
              {{ devops.queue.queued === 1 ? "job" : "jobs" }}
            </button>
          </a-popover>
          <RouterLink v-if="session.isAdmin" to="/admin/users" class="faw-btn">
            Admin
          </RouterLink>
        </template>
      </AppTopbarRight>
    </header>

    <main
      class="flex-1 min-h-0 pb-[calc(3.25rem+env(safe-area-inset-bottom))] lg:pb-0"
      :class="inSettings ? 'overflow-hidden' : 'overflow-hidden'"
    >
      <RouterView />
    </main>

    <MobileBottomNav />
  </div>
</template>
