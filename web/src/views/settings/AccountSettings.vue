<script setup lang="ts">
import { computed, ref } from "vue";
import { message } from "ant-design-vue";
import { useSessionStore } from "@/stores/session";
import { useRouter } from "vue-router";
import { qcApi } from "@/api/qcApi";

const session = useSessionStore();
const router = useRouter();
const qcBusy = ref(false);

const isQc = computed(() => session.isQc);

async function toggleQc(checked: boolean | string | number) {
  const enabled = Boolean(checked);
  qcBusy.value = true;
  try {
    await qcApi.setQcRole(enabled);
    await session.refreshMe();
    message.success(enabled ? "QC role enabled" : "QC role disabled");
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err));
  } finally {
    qcBusy.value = false;
  }
}

async function logout() {
  await session.logout();
  message.success("Signed out");
  await router.replace({ name: "login" });
}
</script>

<template>
  <div class="space-y-4">
    <h2 class="text-lg font-medium m-0">Account</h2>
    <a-descriptions bordered size="small" :column="1" class="faw-settings-desc">
      <a-descriptions-item label="GitLab user">
        @{{ session.me?.gitlabUsername || session.session.username }}
      </a-descriptions-item>
      <a-descriptions-item label="GitLab PAT">
        {{ session.me?.hasGitlabToken ? "Saved (encrypted)" : "Not set" }}
      </a-descriptions-item>
      <a-descriptions-item label="I am QC">
        <div class="flex flex-col gap-1.5 sm:flex-row sm:items-center">
          <a-switch
            :checked="isQc"
            :loading="qcBusy"
            checked-children="QC"
            un-checked-children="Off"
            @change="toggleQc"
          />
          <span class="text-xs text-ink-muted">
            Unlocks /qc APIs and the QC nav
          </span>
        </div>
      </a-descriptions-item>
    </a-descriptions>
    <a-button danger @click="logout">Sign out</a-button>
    <p class="text-xs text-ink-faint m-0">
      To change PAT: sign out, then sign in again with a new token.
    </p>
  </div>
</template>
