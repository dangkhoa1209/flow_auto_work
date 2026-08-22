<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { message } from "ant-design-vue";
import { api } from "@/api/client";
import { useSessionStore } from "@/stores/session";

const session = useSessionStore();
const loading = ref(false);
const figmaToken = ref("");
const clearFigma = ref(false);

const projectId = computed(() => session.projectId || "");
const projectName = computed(
  () =>
    session.currentMembership?.project?.displayName ||
    session.currentMembership?.project?.projectName ||
    projectId.value ||
    "—",
);
const hasFigmaToken = computed(
  () => Boolean(session.currentMembership?.project?.hasFigmaToken),
);

watch(
  () => projectId.value,
  () => {
    figmaToken.value = "";
    clearFigma.value = false;
  },
);

async function saveFigma() {
  const id = projectId.value;
  if (!id) {
    message.warning("Chọn project trước (header / Settings → Project)");
    return;
  }
  const clearing = clearFigma.value;
  if (!clearing && !figmaToken.value.trim()) {
    message.warning("Dán Figma PAT hoặc tick Xóa token");
    return;
  }
  loading.value = true;
  try {
    const res = await api<{
      memberships?: unknown[];
      project?: { hasFigmaToken?: boolean };
    }>(`/api/me/projects/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify({
        figmaToken: clearing ? "" : figmaToken.value.trim(),
      }),
    });
    if (res.memberships) {
      session.setMemberships(res.memberships as never);
    } else {
      await session.refreshMe();
    }
    figmaToken.value = "";
    clearFigma.value = false;
    message.success(
      clearing || res.project?.hasFigmaToken === false
        ? "Đã xóa Figma PAT"
        : "Đã lưu Figma PAT cho project",
    );
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="space-y-6 max-w-xl">
    <div>
      <h2 class="text-base font-semibold text-ink mb-1">Integrations</h2>
      <p class="text-[13px] text-ink-muted">
        Token cấp <strong>project / workspace</strong> — dùng chung mọi job của
        project đang chọn (<span class="text-ink-soft">{{ projectName }}</span
        >).
      </p>
    </div>

    <section
      class="rounded-xl border border-[var(--app-border)] bg-[var(--app-panel)] p-4 space-y-3"
    >
      <div class="flex items-center justify-between gap-2">
        <h3 class="text-sm font-medium text-ink">Figma</h3>
        <span
          class="text-[11px] px-2 py-0.5 rounded-full border"
          :class="
            hasFigmaToken
              ? 'border-emerald-500/40 text-emerald-600'
              : 'border-[var(--app-border)] text-ink-faint'
          "
        >
          {{ hasFigmaToken ? "PAT đã lưu" : "Chưa có PAT" }}
        </span>
      </div>
      <p class="text-[12px] text-ink-muted leading-relaxed">
        Tạo token tại Figma → Settings → Security →
        <em>Personal access tokens</em>, scope
        <code class="text-[11px]">file_content:read</code>. Flow đọc structure /
        text / variables khi bạn tick link Figma trên task (không OAuth).
      </p>
      <div>
        <label class="text-[12px] text-ink-soft">Personal access token</label>
        <a-input-password
          v-model:value="figmaToken"
          class="mt-1"
          placeholder="figu_… (để trống nếu chỉ xóa)"
          autocomplete="new-password"
          :disabled="!projectId || clearFigma"
        />
      </div>
      <label class="flex items-center gap-2 text-[12px] text-ink-soft">
        <a-checkbox v-model:checked="clearFigma" :disabled="!hasFigmaToken" />
        Xóa Figma PAT đã lưu trên project này
      </label>
      <a-button
        type="primary"
        :loading="loading"
        :disabled="!projectId"
        @click="saveFigma"
      >
        Lưu Figma PAT
      </a-button>
    </section>
  </div>
</template>
