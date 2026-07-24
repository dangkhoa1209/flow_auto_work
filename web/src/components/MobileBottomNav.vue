<script setup lang="ts">
import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import {
  ThunderboltOutlined,
  CheckCircleOutlined,
  BarChartOutlined,
  SettingOutlined,
} from "@ant-design/icons-vue";

const route = useRoute();
const router = useRouter();

const tabs = [
  { to: "/work", label: "Work", icon: ThunderboltOutlined },
  { to: "/handoff", label: "Handoff", icon: CheckCircleOutlined },
  { to: "/stats", label: "Stats", icon: BarChartOutlined },
  { to: "/settings", label: "Settings", icon: SettingOutlined },
] as const;

const activePath = computed(() => route.path);

function isActive(to: string) {
  if (to === "/settings") return activePath.value.startsWith("/settings");
  return activePath.value === to || activePath.value.startsWith(`${to}/`);
}

function go(to: string) {
  if (to === "/settings" && !activePath.value.startsWith("/settings")) {
    void router.push("/settings/project");
    return;
  }
  void router.push(to);
}
</script>

<template>
  <nav
    class="lg:hidden fixed inset-x-0 bottom-0 z-[40] border-t border-line bg-surface-raised/95 backdrop-blur-md pb-[env(safe-area-inset-bottom)] shadow-[0_-4px_16px_rgba(15,23,42,0.08)]"
    aria-label="Bottom navigation"
  >
    <div class="grid grid-cols-4 h-[3.25rem]">
      <button
        v-for="t in tabs"
        :key="t.to"
        type="button"
        class="flex flex-col items-center justify-center gap-0.5 h-full fx-colors touch-manipulation"
        :class="
          isActive(t.to) ? 'text-accent' : 'text-ink-faint active:text-ink-muted'
        "
        @click="go(t.to)"
      >
        <component :is="t.icon" class="text-base" />
        <span class="text-[9px] font-medium leading-none">{{ t.label }}</span>
      </button>
    </div>
  </nav>
</template>
