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

const tabs = computed(() => [
  { to: "/work", label: "Work", icon: ThunderboltOutlined },
  { to: "/handoff", label: "Handoff", icon: CheckCircleOutlined },
  { to: "/stats", label: "Stats", icon: BarChartOutlined },
  { to: "/settings", label: "Settings", icon: SettingOutlined },
]);

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
  <nav class="faw-mnav lg:hidden" aria-label="Bottom navigation">
    <div
      class="faw-mnav__grid"
      :style="{ gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))` }"
    >
      <button
        v-for="t in tabs"
        :key="t.to"
        type="button"
        class="faw-mnav__tab touch-manipulation fx-colors"
        :class="{ 'is-active': isActive(t.to) }"
        @click="go(t.to)"
      >
        <component :is="t.icon" class="faw-mnav__icon" />
        <span class="faw-mnav__label">{{ t.label }}</span>
      </button>
    </div>
  </nav>
</template>
