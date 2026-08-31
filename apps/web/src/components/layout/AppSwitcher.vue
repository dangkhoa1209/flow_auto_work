<script setup lang="ts">
import { computed } from "vue";
import { useRoute, RouterLink } from "vue-router";
import { useSessionStore } from "@/stores/session";

const route = useRoute();
const session = useSessionStore();

const links = computed(() => {
  const out: Array<{ to: string; label: string; prefix: string }> = [];
  if (session.canAccessWork) {
    out.push({ to: "/work", label: "Work", prefix: "/work" });
  }
  if (session.canAccessBa) {
    out.push({ to: "/ba", label: "Chat", prefix: "/ba" });
  }
  if (session.canAccessDevops) {
    out.push({ to: "/devops", label: "Build", prefix: "/devops" });
  }
  return out;
});

const show = computed(() => links.value.length > 1);

function isActive(prefix: string): boolean {
  if (prefix === "/work") {
    return (
      route.path.startsWith("/work") ||
      route.path.startsWith("/handoff") ||
      route.path.startsWith("/stats") ||
      (route.path.startsWith("/settings") && session.canAccessWork)
    );
  }
  return route.path.startsWith(prefix);
}
</script>

<template>
  <nav
    v-if="show"
    class="faw-seg faw-app-switch hidden lg:flex"
    aria-label="App switcher"
  >
    <RouterLink
      v-for="item in links"
      :key="item.to"
      :to="item.to"
      class="faw-seg__btn"
      :class="{ active: isActive(item.prefix) }"
    >
      {{ item.label }}
    </RouterLink>
  </nav>
</template>
