<script setup lang="ts">
import { computed } from "vue";
import { message } from "ant-design-vue";
import { useBaChatStore } from "@/stores/baChat";
import BaChatSidebar from "@/components/ba/BaChatSidebar.vue";
import BaMessageList from "@/components/ba/BaMessageList.vue";
import BaComposer from "@/components/ba/BaComposer.vue";

const ba = useBaChatStore();

const composerDisabled = computed(() => {
  if (!ba.selectedProjectId) return true;
  if (!ba.projectReady) return true;
  if (ba.streaming) return true;
  return false;
});

const disabledReason = computed(() => {
  if (!ba.selectedProjectId) return "Chọn project ở sidebar";
  if (!ba.projectReady) return "Project chưa sẵn sàng — liên hệ admin";
  if (ba.streaming) return "Đang trả lời…";
  return "";
});

async function onSend(content: string) {
  try {
    await ba.sendMessage(content);
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  }
}
</script>

<template>
  <div class="h-full min-h-0 flex">
    <BaChatSidebar />
    <section class="flex-1 min-w-0 min-h-0 flex flex-col">
      <div
        class="shrink-0 px-4 py-2.5 border-b border-line flex items-center gap-2"
      >
        <h1 class="text-sm font-semibold text-ink m-0 truncate">
          {{ ba.activeThread?.title || "Project Chat" }}
        </h1>
        <span
          v-if="ba.selectedProject"
          class="text-xs text-ink-muted truncate"
        >
          · {{ ba.selectedProject.displayName }}
        </span>
        <span
          v-if="ba.streaming"
          class="ml-auto text-xs text-blue-600"
        >
          Streaming…
        </span>
      </div>

      <div
        v-if="!ba.projects.length"
        class="flex-1 flex items-center justify-center text-ink-muted text-sm px-6 text-center"
      >
        Chưa có project nào. Admin cần tạo và clone project trước.
      </div>
      <template v-else>
        <BaMessageList
          :messages="ba.messages"
          :streaming="ba.streaming"
          :streaming-message-id="ba.streamingMessageId"
        />
        <p
          v-if="ba.errorText"
          class="px-4 text-xs text-red-600 mb-0"
          role="alert"
        >
          {{ ba.errorText }}
        </p>
        <BaComposer
          :disabled="composerDisabled"
          :disabled-reason="disabledReason"
          :loading="ba.streaming"
          @send="onSend"
        />
      </template>
    </section>
  </div>
</template>
