<script setup lang="ts">
import { onMounted, reactive, ref, watch } from "vue";
import { message } from "ant-design-vue";
import { qaApi } from "@/api/qaApi";
import { useSessionStore } from "@/stores/session";

const session = useSessionStore();
const loading = ref(false);
const saving = ref(false);
const presets = ref<Array<{ id: string; role: string; username: string }>>([]);
const form = reactive({
  stagingBaseUrl: "",
  loginPath: "/api/v1/auth/login",
  tokenJsonPath: "data.accessToken",
  localStorageTokenKey: "accessToken",
  usernameKey: "username",
  passwordKey: "password",
  maxActions: 10,
  actionTimeoutSec: 30,
  maxConcurrentSessions: 1,
});
const presetForm = reactive({ role: "", username: "", password: "" });

async function load() {
  if (!session.ready) return;
  loading.value = true;
  try {
    const [{ config }, presetRes] = await Promise.all([
      qaApi.getConfig(),
      qaApi.listPresets(),
    ]);
    Object.assign(form, {
      stagingBaseUrl: String(config.stagingBaseUrl || ""),
      loginPath: String(config.loginPath || "/api/v1/auth/login"),
      tokenJsonPath: String(config.tokenJsonPath || "data.accessToken"),
      localStorageTokenKey: String(config.localStorageTokenKey || "accessToken"),
      usernameKey: String(
        (config.requestBodyKeys as { username?: string })?.username || "username",
      ),
      passwordKey: String(
        (config.requestBodyKeys as { password?: string })?.password || "password",
      ),
      maxActions: Number(config.maxActions ?? 10),
      actionTimeoutSec: Number(config.actionTimeoutSec ?? 30),
      maxConcurrentSessions: Number(config.maxConcurrentSessions ?? 1),
    });
    presets.value = presetRes.presets;
  } catch (e) {
    message.error(e instanceof Error ? e.message : "Load failed");
  } finally {
    loading.value = false;
  }
}

async function save() {
  saving.value = true;
  try {
    await qaApi.saveConfig({
      stagingBaseUrl: form.stagingBaseUrl,
      loginPath: form.loginPath,
      tokenJsonPath: form.tokenJsonPath,
      localStorageTokenKey: form.localStorageTokenKey,
      requestBodyKeys: {
        username: form.usernameKey,
        password: form.passwordKey,
      },
      maxActions: form.maxActions,
      actionTimeoutSec: form.actionTimeoutSec,
      maxConcurrentSessions: form.maxConcurrentSessions,
    });
    message.success("Đã lưu config");
  } catch (e) {
    message.error(e instanceof Error ? e.message : "Save failed");
  } finally {
    saving.value = false;
  }
}

async function addPreset() {
  try {
    await qaApi.createPreset({ ...presetForm });
    presetForm.role = "";
    presetForm.username = "";
    presetForm.password = "";
    message.success("Đã thêm preset");
    await load();
  } catch (e) {
    message.error(e instanceof Error ? e.message : "Create failed");
  }
}

async function removePreset(id: string) {
  await qaApi.deletePreset(id);
  message.success("Đã xoá");
  await load();
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
  <div class="max-w-3xl mx-auto space-y-6" v-if="!loading">
    <section class="rounded-lg border border-[#232833] bg-panel p-4 space-y-3">
      <h2 class="font-semibold text-white">Project staging & login</h2>
      <a-form layout="vertical">
        <a-form-item label="Staging base URL">
          <a-input v-model:value="form.stagingBaseUrl" placeholder="https://staging.example.com" />
        </a-form-item>
        <div class="grid grid-cols-2 gap-3">
          <a-form-item label="Login path">
            <a-input v-model:value="form.loginPath" />
          </a-form-item>
          <a-form-item label="Token JSON path">
            <a-input v-model:value="form.tokenJsonPath" />
          </a-form-item>
          <a-form-item label="localStorage token key">
            <a-input v-model:value="form.localStorageTokenKey" />
          </a-form-item>
          <a-form-item label="Body username key">
            <a-input v-model:value="form.usernameKey" />
          </a-form-item>
          <a-form-item label="Body password key">
            <a-input v-model:value="form.passwordKey" />
          </a-form-item>
          <a-form-item label="Max actions">
            <a-input-number v-model:value="form.maxActions" :min="1" :max="50" class="w-full" />
          </a-form-item>
          <a-form-item label="Action timeout (sec)">
            <a-input-number v-model:value="form.actionTimeoutSec" :min="5" :max="120" class="w-full" />
          </a-form-item>
          <a-form-item label="Max concurrent sessions">
            <a-input-number v-model:value="form.maxConcurrentSessions" :min="1" :max="5" class="w-full" />
          </a-form-item>
        </div>
        <a-button type="primary" :loading="saving" @click="save">Lưu config</a-button>
      </a-form>
    </section>

    <section class="rounded-lg border border-[#232833] bg-panel p-4 space-y-3">
      <h2 class="font-semibold text-white">Test account presets</h2>
      <a-table
        size="small"
        :pagination="false"
        :data-source="presets"
        :columns="[
          { title: 'Role', dataIndex: 'role' },
          { title: 'Username', dataIndex: 'username' },
          { title: '', key: 'actions' },
        ]"
        row-key="id"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'actions'">
            <a-button size="small" danger @click="removePreset(record.id)">Xoá</a-button>
          </template>
        </template>
      </a-table>
      <div class="grid grid-cols-3 gap-2">
        <a-input v-model:value="presetForm.role" placeholder="Role (Admin)" />
        <a-input v-model:value="presetForm.username" placeholder="Username" />
        <a-input-password v-model:value="presetForm.password" placeholder="Password" />
      </div>
      <a-button @click="addPreset">Thêm preset</a-button>
    </section>
  </div>
  <div v-else class="text-muted">Đang tải…</div>
</template>
