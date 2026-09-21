<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import { CloseOutlined } from "@ant-design/icons-vue";
import { useGreeting } from "@/composables/useGreeting";
import { consumePostLoginGreeting } from "@/utils/postLoginGreeting";

const { greeting, displayName, todayLabel } = useGreeting();

const visible = ref(false);
let hideTimer: ReturnType<typeof setTimeout> | null = null;

function dismiss() {
  visible.value = false;
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
}

onMounted(() => {
  if (!consumePostLoginGreeting()) return;
  visible.value = true;
  hideTimer = setTimeout(() => {
    visible.value = false;
    hideTimer = null;
  }, 6500);
});

onUnmounted(() => {
  if (hideTimer) clearTimeout(hideTimer);
});
</script>

<template>
  <Transition name="faw-welcome">
    <aside
      v-if="visible"
      class="faw-welcome"
      role="status"
      aria-live="polite"
    >
      <div class="faw-welcome__copy">
        <p class="faw-welcome__date">{{ todayLabel }}</p>
        <p class="faw-welcome__hello">
          {{ greeting }}, <strong>{{ displayName }}</strong>
        </p>
      </div>
      <button
        type="button"
        class="faw-welcome__close"
        title="Dismiss"
        aria-label="Dismiss welcome"
        @click="dismiss"
      >
        <CloseOutlined />
      </button>
    </aside>
  </Transition>
</template>
