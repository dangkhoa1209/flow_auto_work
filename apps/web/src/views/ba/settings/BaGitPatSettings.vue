<script setup lang="ts">
import { ref } from "vue";
import { message } from "ant-design-vue";
import BaGitPatForm from "@/components/ba/BaGitPatForm.vue";
import { useBaGitPat } from "@/composables/useBaGitPat";

const { saveGitPat } = useBaGitPat();
const saving = ref(false);
const patFormRef = ref<InstanceType<typeof BaGitPatForm> | null>(null);

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
</script>

<template>
  <div class="faw-settings-detail">
    <h2>GitLab PAT</h2>
    <p class="faw-settings-detail__lead">
      PAT đọc GitLab cho project chat — issue, branch, MR.
    </p>
    <BaGitPatForm
      ref="patFormRef"
      show-status
      :loading="saving"
      @save="onSavePat"
    />
  </div>
</template>
