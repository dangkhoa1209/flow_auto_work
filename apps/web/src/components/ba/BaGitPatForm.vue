<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { LinkOutlined } from "@ant-design/icons-vue";
import { ensureGitPatBootstrap, useBaGitPat } from "@/composables/useBaGitPat";

defineProps<{
  loading?: boolean;
  showStatus?: boolean;
  hideDefaultActions?: boolean;
}>();

const emit = defineEmits<{
  save: [token: string];
}>();

const { gitlabBaseUrl, gitlabPatUrl, hasGitPat } = useBaGitPat();
const token = ref("");

const gitlabHostLabel = computed(() =>
  gitlabBaseUrl.value.replace(/^https?:\/\//, ""),
);

onMounted(() => {
  void ensureGitPatBootstrap();
});

function onSubmit() {
  emit("save", token.value);
}

function clearInput() {
  token.value = "";
}

function getToken() {
  return token.value;
}

defineExpose({ clearInput, getToken, onSubmit });
</script>

<template>
  <div class="space-y-4 text-[13px] leading-relaxed">
    <div
      v-if="showStatus"
      class="flex items-center justify-between gap-2 rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)] px-3 py-2"
    >
      <span class="text-[12px] text-[var(--app-muted)]">Trạng thái PAT</span>
      <span
        class="text-[11px] px-2 py-0.5 rounded-full border"
        :class="
          hasGitPat
            ? 'border-emerald-500/40 text-emerald-600'
            : 'border-[var(--app-border)] text-[var(--app-faint)]'
        "
      >
        {{ hasGitPat ? "Đã lưu (mã hoá)" : "Chưa có PAT" }}
      </span>
    </div>

    <p class="m-0 text-[var(--app-ink)]">
      PAT cá nhân dùng khi <strong>lên task GitLab</strong>. Token được mã hoá
      trên server — không hiển thị lại sau khi lưu. Dán PAT mới bất cứ lúc nào
      để thay thế.
    </p>

    <div
      class="rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)] p-3 space-y-2"
    >
      <p class="m-0 text-[12px] font-medium text-[var(--app-ink)]">
        Cách lấy PAT
      </p>
      <ol class="m-0 pl-4 text-[12px] text-[var(--app-muted)] space-y-1">
        <li>
          Mở GitLab → <strong>Preferences → Access Tokens</strong> (Personal
          access tokens).
        </li>
        <li>
          Tạo token mới, chọn scope
          <code class="text-[11px]">api</code> (và
          <code class="text-[11px]">read_repository</code> nếu cần).
        </li>
        <li>
          Copy token (dạng <code class="text-[11px]">glpat-…</code>) và dán bên
          dưới.
        </li>
      </ol>
      <a
        :href="gitlabPatUrl"
        target="_blank"
        rel="noopener noreferrer"
        class="inline-flex items-center gap-1.5 text-[12px] font-medium text-[var(--app-accent)] hover:underline"
      >
        <LinkOutlined />
        Mở trang tạo PAT trên {{ gitlabHostLabel }}
      </a>
    </div>

    <div>
      <label class="faw-ba-label block mb-1">
        {{ hasGitPat ? "PAT mới (thay thế)" : "Personal access token" }}
      </label>
      <a-input-password
        v-model:value="token"
        placeholder="glpat-…"
        autocomplete="new-password"
        :disabled="loading"
        @press-enter="onSubmit"
      />
    </div>

    <slot v-if="!hideDefaultActions" name="actions">
      <button
        type="button"
        class="faw-btn faw-btn--run"
        :disabled="loading || !token.trim()"
        @click="onSubmit"
      >
        {{ loading ? "Đang lưu…" : hasGitPat ? "Cập nhật PAT" : "Lưu PAT" }}
      </button>
    </slot>
  </div>
</template>
