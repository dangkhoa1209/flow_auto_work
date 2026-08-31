<script setup lang="ts">
import { computed, ref } from "vue";
import SettingsCursorPanel from "@/components/settings/SettingsCursorPanel.vue";
import { useSessionStore } from "@/stores/session";

type ProviderId = "cursor";

const session = useSessionStore();
const activeId = ref<ProviderId>("cursor");

const cursorStatusLabel = computed(() => {
  const pats = session.me?.cursorPats ?? [];
  if (!pats.length) return "Chưa có PAT";
  const active = pats.find((p) => p.isActive);
  if (!active) return `${pats.length} PAT · chưa active`;
  return `Active: ${active.label}`;
});

const cursorStatusOk = computed(() => Boolean(session.me?.hasCursorApiKey));

const providers = computed(() => [
  {
    id: "cursor" as const,
    label: "Cursor",
    hint: "Provider agent · mọi project",
    status: cursorStatusLabel.value,
    ok: cursorStatusOk.value,
  },
]);

function selectProvider(id: ProviderId) {
  activeId.value = id;
}
</script>

<template>
  <div class="faw-integrations">
    <header class="faw-settings-detail faw-integrations__head">
      <h2>AI Engine</h2>
      <p class="faw-settings-detail__lead m-0 mt-1">
        Nền tảng chạy agent — chọn provider và cấu hình PAT / model.
      </p>
    </header>

    <div class="faw-integrations__shell">
      <aside class="faw-integrations__list" aria-label="Danh sách providers">
        <button
          v-for="item in providers"
          :key="item.id"
          type="button"
          class="faw-integrations__item"
          :class="{ 'is-active': activeId === item.id }"
          @click="selectProvider(item.id)"
        >
          <span class="faw-integrations__item-top">
            <span class="faw-integrations__item-label">{{ item.label }}</span>
            <span
              class="faw-integrations__item-badge"
              :class="item.ok ? 'is-ok' : ''"
            >
              {{ item.status }}
            </span>
          </span>
          <span class="faw-integrations__item-hint">{{ item.hint }}</span>
        </button>
      </aside>

      <div class="faw-integrations__detail">
        <SettingsCursorPanel v-if="activeId === 'cursor'" />
      </div>
    </div>
  </div>
</template>
