<script setup lang="ts">
import { computed } from "vue";
import { message } from "ant-design-vue";
import { useBaChatStore } from "@/stores/baChat";
import BaChatSidebar from "@/components/ba/BaChatSidebar.vue";
import BaMessageList from "@/components/ba/BaMessageList.vue";
import BaComposer from "@/components/ba/BaComposer.vue";
import BaProgressRail from "@/components/ba/BaProgressRail.vue";

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
  <div class="faw-ba h-full min-h-0 flex overflow-hidden">
    <BaChatSidebar />

    <section class="faw-console flex-1 min-w-0 min-h-0 flex flex-col">
      <div class="faw-console-head">
        <div class="faw-console-head__title">
          <h2>{{ ba.activeThread?.title || "Project Chat" }}</h2>
          <div class="faw-console-head__win">
            <template v-if="ba.selectedProject">
              {{ ba.selectedProject.displayName }}
              <template v-if="ba.selectedProject.gitlabPath">
                · {{ ba.selectedProject.gitlabPath }}
              </template>
            </template>
            <template v-else>Chưa chọn project</template>
          </div>
        </div>
        <div class="faw-console-actions">
          <span
            v-if="ba.streaming"
            class="faw-idle text-[11px]"
          >
            <span class="faw-idle__dot wip" />
            {{ ba.currentProgressLabel || "Streaming" }}
          </span>
        </div>
      </div>

      <BaProgressRail />

      <div
        v-if="!ba.projects.length"
        class="flex-1 flex items-center justify-center px-6"
      >
        <a-empty description="Chưa có project — admin cần tạo và clone trước" />
      </div>

      <template v-else>
        <BaMessageList
          :messages="ba.messages"
          :streaming="ba.streaming"
          :streaming-message-id="ba.streamingMessageId"
          :progress-hint="ba.currentProgressLabel"
        />
        <div
          v-if="ba.errorText"
          class="shrink-0 px-3 pb-1"
        >
          <a-alert type="error" show-icon :message="ba.errorText" />
        </div>
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
