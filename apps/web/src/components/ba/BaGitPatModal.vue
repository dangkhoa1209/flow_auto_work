<script setup lang="ts">
import { ref, watch } from "vue";
import { RouterLink } from "vue-router";
import { message } from "ant-design-vue";
import BaGitPatForm from "@/components/ba/BaGitPatForm.vue";
import { useBaGitPat } from "@/composables/useBaGitPat";

const { modalOpen, saveGitPat, closePatModal } = useBaGitPat();

const saving = ref(false);
const patFormRef = ref<InstanceType<typeof BaGitPatForm> | null>(null);

watch(modalOpen, (open) => {
  if (open) patFormRef.value?.clearInput();
});

async function onSave() {
  const token = patFormRef.value?.getToken() ?? "";
  if (!token.trim()) return;
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
</script>

<template>
  <a-modal
    :open="modalOpen"
    title="GitLab PAT cần thiết"
    :width="520"
    :footer="null"
    @cancel="closePatModal"
  >
    <BaGitPatForm ref="patFormRef" :loading="saving" hide-default-actions @save="onSave" />
    <p class="text-[11px] text-[var(--app-faint)] m-0 mt-4">
      Hoặc vào
      <RouterLink
        to="/ba/settings"
        class="text-[var(--app-accent)] hover:underline"
        @click="closePatModal"
      >
        Settings
      </RouterLink>
      để quản lý PAT sau này.
    </p>
    <div class="flex justify-end gap-2 mt-4 pt-3 border-t border-[var(--app-border)]">
      <button type="button" class="faw-btn" @click="closePatModal">Để sau</button>
      <button
        type="button"
        class="faw-btn faw-btn--run"
        :disabled="saving || !(patFormRef?.getToken() || '').trim()"
        @click="onSave"
      >
        {{ saving ? "Đang lưu…" : "Lưu PAT" }}
      </button>
    </div>
  </a-modal>
</template>
