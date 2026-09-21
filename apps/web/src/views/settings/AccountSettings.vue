<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { message } from "ant-design-vue";
import { useRouter } from "vue-router";
import { api } from "@/api/client";
import { API } from "@/api/endpoints";
import { useSessionStore } from "@/stores/session";

const session = useSessionStore();
const router = useRouter();

const loading = ref(false);
const currentPassword = ref("");
const newPassword = ref("");
const confirmPassword = ref("");

const username = computed(
  () =>
    session.me?.gitlabUsername ||
    session.session.username ||
    "—",
);

const displayName = computed(
  () => session.me?.displayName?.trim() || "—",
);

const hasPassword = computed(() => Boolean(session.me?.hasPassword));

onMounted(async () => {
  if (!session.me) await session.refreshMe();
});

async function changePassword() {
  if (!newPassword.value.trim()) {
    message.warning("Enter a new password");
    return;
  }
  if (newPassword.value.length < 6) {
    message.warning("New password must be at least 6 characters");
    return;
  }
  if (newPassword.value !== confirmPassword.value) {
    message.warning("Passwords do not match");
    return;
  }
  if (hasPassword.value && !currentPassword.value.trim()) {
    message.warning("Enter your current password");
    return;
  }

  loading.value = true;
  try {
    const res = await api<{ user?: Record<string, unknown> }>(API.me.password, {
      method: "PUT",
      body: JSON.stringify({
        currentPassword: hasPassword.value
          ? currentPassword.value.trim()
          : undefined,
        newPassword: newPassword.value.trim(),
      }),
    });
    if (res.user) {
      session.me = { ...session.me, ...res.user };
    } else {
      await session.refreshMe();
    }
    currentPassword.value = "";
    newPassword.value = "";
    confirmPassword.value = "";
    message.success("Password updated");
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  } finally {
    loading.value = false;
  }
}

async function logout() {
  await session.logout();
  message.success("Signed out");
  await router.replace({ name: "login" });
}
</script>

<template>
  <div class="faw-settings-detail faw-account">
    <h2>Account</h2>
    <p class="faw-settings-detail__lead">
      Profile, password, and sign-out for this workspace.
    </p>

    <section class="faw-account__profile">
      <div class="faw-account__field">
        <span class="faw-account__label">Username</span>
        <span class="faw-account__value">@{{ username }}</span>
      </div>
      <div class="faw-account__field">
        <span class="faw-account__label">Name</span>
        <span class="faw-account__value">{{ displayName }}</span>
      </div>
    </section>

    <section class="faw-account__section">
      <h3 class="faw-account__section-title">Change password</h3>
      <a-form layout="vertical" class="faw-account__form">
        <a-form-item v-if="hasPassword" label="Current password">
          <a-input-password
            v-model:value="currentPassword"
            autocomplete="current-password"
          />
        </a-form-item>
        <a-form-item label="New password">
          <a-input-password
            v-model:value="newPassword"
            autocomplete="new-password"
          />
        </a-form-item>
        <a-form-item label="Confirm new password">
          <a-input-password
            v-model:value="confirmPassword"
            autocomplete="new-password"
          />
        </a-form-item>
        <a-button type="primary" :loading="loading" @click="changePassword">
          Save password
        </a-button>
      </a-form>
    </section>

    <section class="faw-account__section faw-account__logout">
      <a-button danger @click="logout">Sign out</a-button>
    </section>
  </div>
</template>
