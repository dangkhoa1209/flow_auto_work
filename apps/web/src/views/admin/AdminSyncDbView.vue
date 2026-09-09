<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";
import { message } from "ant-design-vue";
import { syncDbApi, type SyncDbSystemConfigPublic } from "@/api/syncDbApi";

const loading = ref(false);
const saving = ref(false);
const config = ref<SyncDbSystemConfigPublic | null>(null);

const form = reactive({
  enabled: false,
  sshHost: "",
  sshPort: 22,
  sshUsername: "",
  sshPassword: "",
  sshPrivateKey: "",
  clearSshPassword: false,
  clearSshPrivateKey: false,
  tunnelLocalPort: 27019,
  remoteMongoHost: "localhost",
  remoteMongoPort: 27017,
  sourceUsername: "",
  sourcePassword: "",
  clearSourcePassword: false,
  sourceAuthSource: "admin",
  dropTarget: true,
  timeoutSec: 3600,
});

function applyConfig(c: SyncDbSystemConfigPublic) {
  config.value = c;
  form.enabled = c.enabled;
  form.sshHost = c.sshHost || "";
  form.sshPort = c.sshPort;
  form.sshUsername = c.sshUsername || "";
  form.sshPassword = "";
  form.sshPrivateKey = "";
  form.clearSshPassword = false;
  form.clearSshPrivateKey = false;
  form.tunnelLocalPort = c.tunnelLocalPort;
  form.remoteMongoHost = c.remoteMongoHost;
  form.remoteMongoPort = c.remoteMongoPort;
  form.sourceUsername = c.sourceUsername || "";
  form.sourcePassword = "";
  form.clearSourcePassword = false;
  form.sourceAuthSource = c.sourceAuthSource;
  form.dropTarget = c.dropTarget;
  form.timeoutSec = c.timeoutSec;
}

async function load() {
  loading.value = true;
  try {
    const data = await syncDbApi.adminGetConfig();
    applyConfig(data.config);
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  } finally {
    loading.value = false;
  }
}

async function save() {
  saving.value = true;
  try {
    const body: Record<string, unknown> = {
      enabled: form.enabled,
      sshHost: form.sshHost.trim(),
      sshPort: form.sshPort,
      sshUsername: form.sshUsername.trim(),
      tunnelLocalPort: form.tunnelLocalPort,
      remoteMongoHost: form.remoteMongoHost.trim() || "localhost",
      remoteMongoPort: form.remoteMongoPort,
      sourceUsername: form.sourceUsername.trim(),
      sourceAuthSource: form.sourceAuthSource.trim() || "admin",
      dropTarget: form.dropTarget,
      timeoutSec: form.timeoutSec,
    };
    if (form.sshPassword.trim()) body.sshPassword = form.sshPassword;
    if (form.sshPrivateKey.trim()) body.sshPrivateKey = form.sshPrivateKey;
    if (form.sourcePassword.trim()) body.sourcePassword = form.sourcePassword;
    if (form.clearSshPassword) body.clearSshPassword = true;
    if (form.clearSshPrivateKey) body.clearSshPrivateKey = true;
    if (form.clearSourcePassword) body.clearSourcePassword = true;

    const data = await syncDbApi.adminPutConfig(body);
    applyConfig(data.config);
    message.success("Sync Database settings saved");
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  } finally {
    saving.value = false;
  }
}

onMounted(() => {
  void load();
});
</script>

<template>
  <div class="max-w-2xl mx-auto px-4 py-6">
    <h1 class="text-xl font-semibold text-ink m-0 mb-1">Sync Database</h1>
    <p class="text-sm text-ink-muted mb-4">
      System credentials for BA Chat sync: SSH tunnel + <strong>read-only</strong>
      source Mongo (live). Target DB comes from each project’s Connect DB and
      <strong>must be loopback</strong> (<code>127.0.0.1</code> / <code>localhost</code>) —
      never restore to live.
    </p>

    <a-alert
      type="warning"
      show-icon
      class="mb-4"
      message="Live DB must use a read-only Mongo user. Restore target is hard-locked to loopback. Secrets are encrypted at rest and never returned to the browser or BA agent tools."
    />

    <div
      v-if="config"
      class="mb-3 text-xs text-ink-muted"
    >
      Status:
      <span :class="config.configured && config.enabled ? 'text-emerald-600' : 'text-amber-600'">
        {{
          config.configured && config.enabled
            ? "Ready"
            : config.configured
              ? "Configured but disabled"
              : "Not configured"
        }}
      </span>
      <template v-if="config.updatedAt">
        · updated {{ config.updatedAt.slice(0, 19).replace("T", " ") }}
        <template v-if="config.updatedBy"> by @{{ config.updatedBy }}</template>
      </template>
    </div>

    <div class="p-4 rounded-lg border border-line bg-surface-raised space-y-4">
      <div class="flex items-center justify-between gap-3">
        <div>
          <div class="text-sm font-medium text-ink">Enable Sync Database</div>
          <div class="text-xs text-ink-muted">
            When on, BA users with a Mongo Connect DB can sync (feature flag must not be Hide).
          </div>
        </div>
        <a-switch v-model:checked="form.enabled" :disabled="loading" />
      </div>

      <a-divider class="!my-2" />

      <div class="text-sm font-medium text-ink">SSH (live server)</div>
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label class="block text-xs text-ink-muted">
          Host
          <a-input v-model:value="form.sshHost" :disabled="loading" class="mt-1" />
        </label>
        <label class="block text-xs text-ink-muted">
          Port
          <a-input-number
            v-model:value="form.sshPort"
            :min="1"
            :max="65535"
            :disabled="loading"
            class="mt-1 w-full"
          />
        </label>
        <label class="block text-xs text-ink-muted sm:col-span-2">
          Username
          <a-input v-model:value="form.sshUsername" :disabled="loading" class="mt-1" />
        </label>
        <label class="block text-xs text-ink-muted sm:col-span-2">
          Password
          <span v-if="config?.hasSshPassword" class="text-emerald-600">(set)</span>
          <a-input-password
            v-model:value="form.sshPassword"
            :disabled="loading"
            placeholder="Leave blank to keep"
            class="mt-1"
          />
        </label>
        <label class="block text-xs text-ink-muted sm:col-span-2">
          Private key (optional, instead of password)
          <span v-if="config?.hasSshPrivateKey" class="text-emerald-600">(set)</span>
          <a-textarea
            v-model:value="form.sshPrivateKey"
            :disabled="loading"
            :rows="3"
            placeholder="Leave blank to keep"
            class="mt-1 font-mono text-xs"
          />
        </label>
      </div>

      <a-divider class="!my-2" />

      <div class="text-sm font-medium text-ink">Tunnel → source Mongo</div>
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label class="block text-xs text-ink-muted">
          Local tunnel port
          <a-input-number
            v-model:value="form.tunnelLocalPort"
            :min="1024"
            :max="65535"
            :disabled="loading"
            class="mt-1 w-full"
          />
        </label>
        <label class="block text-xs text-ink-muted">
          Remote Mongo host (from SSH)
          <a-input
            v-model:value="form.remoteMongoHost"
            :disabled="loading"
            class="mt-1"
          />
        </label>
        <label class="block text-xs text-ink-muted">
          Remote Mongo port
          <a-input-number
            v-model:value="form.remoteMongoPort"
            :min="1"
            :max="65535"
            :disabled="loading"
            class="mt-1 w-full"
          />
        </label>
        <label class="block text-xs text-ink-muted">
          Auth source
          <a-input
            v-model:value="form.sourceAuthSource"
            :disabled="loading"
            class="mt-1"
          />
        </label>
        <label class="block text-xs text-ink-muted">
          Source Mongo username (read-only role)
          <a-input
            v-model:value="form.sourceUsername"
            :disabled="loading"
            class="mt-1"
          />
        </label>
        <label class="block text-xs text-ink-muted">
          Source Mongo password
          <span v-if="config?.hasSourcePassword" class="text-emerald-600">(set)</span>
          <a-input-password
            v-model:value="form.sourcePassword"
            :disabled="loading"
            placeholder="Leave blank to keep"
            class="mt-1"
          />
        </label>
      </div>

      <a-divider class="!my-2" />

      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div class="flex items-center justify-between gap-3">
          <div>
            <div class="text-sm text-ink">Drop target collections</div>
            <div class="text-xs text-ink-muted">mongorestore --drop on project DB</div>
          </div>
          <a-switch v-model:checked="form.dropTarget" :disabled="loading" />
        </div>
        <label class="block text-xs text-ink-muted">
          Timeout (seconds)
          <a-input-number
            v-model:value="form.timeoutSec"
            :min="60"
            :max="86400"
            :disabled="loading"
            class="mt-1 w-full"
          />
        </label>
      </div>

      <div class="flex justify-end gap-2 pt-2">
        <a-button :disabled="loading || saving" @click="load">Reload</a-button>
        <a-button type="primary" :loading="saving" :disabled="loading" @click="save">
          Save
        </a-button>
      </div>
    </div>
  </div>
</template>
