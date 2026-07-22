<script setup lang="ts">
import { message } from "ant-design-vue";
import { useSessionStore } from "@/stores/session";
import { useRouter } from "vue-router";

const session = useSessionStore();
const router = useRouter();

async function logout() {
  await session.logout();
  message.success("Đã đăng xuất");
  await router.replace({ name: "login" });
}
</script>

<template>
  <div class="space-y-4">
    <h2 class="text-lg font-medium m-0">Tài khoản</h2>
    <a-descriptions bordered size="small" :column="1">
      <a-descriptions-item label="GitLab user">
        @{{ session.me?.gitlabUsername || session.session.username }}
      </a-descriptions-item>
      <a-descriptions-item label="GitLab PAT">
        {{ session.me?.hasGitlabToken ? "Đã lưu (encrypted)" : "Chưa có" }}
      </a-descriptions-item>
    </a-descriptions>
    <a-button danger @click="logout">Đăng xuất</a-button>
    <p class="text-xs text-ink-faint m-0">
      Đổi PAT: logout rồi login lại với token mới.
    </p>
  </div>
</template>
