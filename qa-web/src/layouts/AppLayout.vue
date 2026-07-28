<script setup lang="ts">
import { onMounted, ref } from "vue";
import { RouterLink, RouterView, useRouter } from "vue-router";
import { useSessionStore } from "@/stores/session";
import { useAuthStore } from "@/stores/auth";

const session = useSessionStore();
const auth = useAuthStore();
const router = useRouter();
const booting = ref(true);

onMounted(async () => {
  try {
    await session.bootstrap();
    if (!auth.isAuthenticated) {
      router.replace({ name: "login", query: { redirect: router.currentRoute.value.fullPath } });
      return;
    }
  } catch {
    await session.logout();
    router.replace("/login");
  } finally {
    booting.value = false;
  }
});

function onProjectChange(id: string) {
  session.selectProject(id);
}

async function logout() {
  await session.logout();
  router.push("/login");
}
</script>

<template>
  <div class="h-[100dvh] flex flex-col">
    <header
      class="flex items-center gap-4 px-4 h-12 border-b border-[#232833] bg-[#12151C] shrink-0"
    >
      <div class="font-semibold text-white tracking-wide">QA Agents</div>
      <nav class="flex gap-3 text-sm">
        <RouterLink class="text-muted hover:text-white" active-class="!text-accent" to="/trigger">
          Trigger
        </RouterLink>
        <RouterLink class="text-muted hover:text-white" active-class="!text-accent" to="/review">
          Review
        </RouterLink>
        <RouterLink class="text-muted hover:text-white" active-class="!text-accent" to="/config">
          Config
        </RouterLink>
      </nav>
      <div class="ml-auto flex items-center gap-3">
        <a-select
          v-if="session.memberships.length"
          :value="session.projectId || undefined"
          style="min-width: 220px"
          placeholder="Chọn project"
          @change="(v: string) => onProjectChange(v)"
        >
          <a-select-option
            v-for="m in session.memberships"
            :key="m.projectId"
            :value="m.projectId"
          >
            {{ m.project?.displayName || m.project?.gitlabPath || m.projectId }}
          </a-select-option>
        </a-select>
        <span class="text-muted text-xs">{{ session.username }}</span>
        <a-button size="small" @click="logout">Logout</a-button>
      </div>
    </header>

    <main class="flex-1 overflow-auto p-4">
      <div v-if="booting" class="text-muted p-6">Đang khởi tạo session…</div>
      <div
        v-else-if="!session.projectId"
        class="max-w-lg mx-auto mt-16 rounded-lg border border-[#232833] bg-[#12151C] p-6 space-y-3"
      >
        <h2 class="text-white font-semibold">Chưa chọn project</h2>
        <p class="text-muted text-sm">
          API QA cần header <code class="text-accent">X-Flow-Project</code>.
          Hãy chọn project ở góc phải, hoặc tạo/join project trong Flow WorkBench rồi đăng nhập lại.
        </p>
        <a-select
          v-if="session.memberships.length"
          class="w-full"
          placeholder="Chọn project"
          :value="session.projectId || undefined"
          @change="(v: string) => onProjectChange(v)"
        >
          <a-select-option
            v-for="m in session.memberships"
            :key="m.projectId"
            :value="m.projectId"
          >
            {{ m.project?.displayName || m.project?.gitlabPath || m.projectId }}
          </a-select-option>
        </a-select>
        <p v-else class="text-amber-300 text-sm">
          Tài khoản chưa có membership project nào.
        </p>
      </div>
      <RouterView v-else />
    </main>
  </div>
</template>
