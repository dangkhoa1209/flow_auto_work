<script setup lang="ts">
import { onMounted, reactive, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { message } from "ant-design-vue";
import { qaApi, type QaJob } from "@/api/qaApi";
import { useSessionStore } from "@/stores/session";

const session = useSessionStore();
const router = useRouter();
const presets = ref<Array<{ id: string; role: string; username: string }>>([]);
const jobs = ref<QaJob[]>([]);
const loading = ref(false);
const form = reactive({
  targetUrl: "",
  presetId: undefined as string | undefined,
  testcase: "",
});

async function load() {
  if (!session.ready) return;
  const [p, j] = await Promise.all([qaApi.listPresets(), qaApi.listJobs()]);
  presets.value = p.presets;
  jobs.value = j.jobs;
}

async function start() {
  if (!form.targetUrl || !form.presetId || !form.testcase) {
    message.warning("Điền đủ URL, preset và testcase");
    return;
  }
  loading.value = true;
  try {
    const { job } = await qaApi.createJob({
      targetUrl: form.targetUrl,
      presetId: form.presetId,
      testcase: form.testcase,
    });
    message.success("Đã enqueue QA job");
    router.push(`/review/${job.id}`);
  } catch (e) {
    message.error(e instanceof Error ? e.message : "Start failed");
  } finally {
    loading.value = false;
  }
}

watch(
  () => session.ready,
  (ok) => {
    if (ok) void load();
  },
  { immediate: true },
);

onMounted(() => {
  if (session.ready) void load();
});
</script>

<template>
  <div class="max-w-3xl mx-auto space-y-6">
    <section class="rounded-lg border border-[#232833] bg-panel p-4 space-y-3">
      <h2 class="font-semibold text-white">Tạo yêu cầu QA</h2>
      <a-form layout="vertical">
        <a-form-item label="URL bị lỗi" required>
          <a-input v-model:value="form.targetUrl" placeholder="https://staging…/path" />
        </a-form-item>
        <a-form-item label="Account preset" required>
          <a-select
            v-model:value="form.presetId"
            placeholder="Chọn preset"
            class="w-full"
            :options="presets.map((p) => ({ value: p.id, label: `${p.role} (${p.username})` }))"
          />
        </a-form-item>
        <a-form-item label="Mô tả lỗi / Testcase" required>
          <a-textarea v-model:value="form.testcase" :rows="6" placeholder="Steps to reproduce…" />
        </a-form-item>
        <a-button type="primary" :loading="loading" @click="start">Start QA Agent</a-button>
      </a-form>
    </section>

    <section class="rounded-lg border border-[#232833] bg-panel p-4 space-y-2">
      <h2 class="font-semibold text-white">Jobs gần đây</h2>
      <div
        v-for="j in jobs"
        :key="j.id"
        class="flex items-center justify-between py-2 border-b border-[#232833] last:border-0 cursor-pointer hover:bg-[#171B24] px-2 rounded"
        @click="router.push(`/review/${j.id}`)"
      >
        <div>
          <div class="text-white text-sm">{{ j.qa?.testcase?.slice(0, 80) || j.id }}</div>
          <div class="text-muted text-xs">{{ j.qa?.targetUrl }}</div>
        </div>
        <a-tag>{{ j.status }}</a-tag>
      </div>
    </section>
  </div>
</template>
