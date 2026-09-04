<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from "vue";
import { message, Modal } from "ant-design-vue";
import { CopyOutlined, MoreOutlined } from "@ant-design/icons-vue";
import { api } from "@/api/client";
import { API } from "@/api/endpoints";
import { useSessionStore } from "@/stores/session";

type UserRole = "dev" | "admin" | "qc" | "ba" | "pd" | "devops";

type AdminUser = {
  id: string;
  gitlabUsername: string;
  displayName?: string;
  roles: UserRole[];
  hasPassword: boolean;
  disabled: boolean;
  disabledAt?: string | null;
  isRootAdmin: boolean;
  createdAt: string;
  updatedAt: string;
  baChatMessageCount?: number;
  baChatMessageActiveCount?: number;
  baChatMessageDeletedCount?: number;
  baChatThreadCount?: number;
};

const ALL_ROLES: UserRole[] = ["dev", "admin", "qc", "ba", "pd", "devops"];

const ROLE_LABELS: Record<UserRole, string> = {
  dev: "Dev",
  admin: "Admin",
  qc: "QC",
  ba: "BA",
  pd: "PD",
  devops: "Build",
};

const roleOptions = ALL_ROLES.map((r) => ({
  value: r,
  label: ROLE_LABELS[r],
}));

const columns = [
  { title: "User", key: "user", width: 220 },
  { title: "Role", key: "roles", width: 120 },
  { title: "Chatbox", key: "chatbox", width: 130 },
  { title: "Status", key: "status", width: 120 },
  { title: "Password", key: "password", width: 100 },
  { title: "Updated", key: "updatedAt", width: 110 },
  { title: "", key: "actions", width: 52, align: "right" as const, fixed: "right" as const },
];

const session = useSessionStore();
const loading = ref(false);
const saving = ref(false);
const users = ref<AdminUser[]>([]);
const search = ref("");
const showDisabled = ref(true);
const page = ref(1);
const pageSize = ref(10);

const createOpen = ref(false);
const editOpen = ref(false);
const editingUser = ref<AdminUser | null>(null);

const credModal = reactive({
  open: false,
  username: "",
  password: "",
});

const createForm = reactive({
  username: "",
  displayName: "",
  role: "dev" as UserRole,
});

const editForm = reactive({
  displayName: "",
  role: "dev" as UserRole,
});

const filteredUsers = computed(() => {
  const q = search.value.trim().toLowerCase();
  return users.value.filter((u) => {
    if (!showDisabled.value && u.disabled) return false;
    if (!q) return true;
    return (
      u.id.includes(q) ||
      u.gitlabUsername.toLowerCase().includes(q) ||
      (u.displayName || "").toLowerCase().includes(q) ||
      u.roles.some((r) => r.includes(q))
    );
  });
});

const stats = computed(() => ({
  total: users.value.length,
  active: users.value.filter((u) => !u.disabled).length,
  disabled: users.value.filter((u) => u.disabled).length,
}));

watch([search, showDisabled], () => {
  page.value = 1;
});

function primaryRole(u: AdminUser): UserRole {
  return u.roles[0] || "dev";
}

function isSelf(u: AdminUser): boolean {
  return u.id === session.me?.id;
}

function isProtected(u: AdminUser): boolean {
  return u.isRootAdmin;
}

function chatboxUsageTitle(u: AdminUser): string {
  const total = u.baChatMessageCount ?? 0;
  const active = u.baChatMessageActiveCount ?? 0;
  const deleted = u.baChatMessageDeletedCount ?? 0;
  const threads = u.baChatThreadCount ?? 0;
  return `Project Chatbox usage (includes soft-deleted)\nMessages: ${total} total · ${active} active · ${deleted} deleted\nThreads: ${threads}`;
}

function resetCreateForm() {
  createForm.username = "";
  createForm.displayName = "";
  createForm.role = "dev";
}

function openCreate() {
  resetCreateForm();
  createOpen.value = true;
}

function openEdit(u: AdminUser) {
  if (isProtected(u)) {
    message.warning("Root admin account cannot be edited");
    return;
  }
  editingUser.value = u;
  editForm.displayName = u.displayName || "";
  editForm.role = primaryRole(u);
  editOpen.value = true;
}

function showCredential(username: string, password: string) {
  credModal.username = username;
  credModal.password = password;
  credModal.open = true;
}

async function copyCredential() {
  try {
    await navigator.clipboard.writeText(credModal.password);
    message.success("Password copied");
  } catch {
    message.warning("Could not copy — select and copy manually");
  }
}

async function load() {
  loading.value = true;
  try {
    const data = await api<{ users?: AdminUser[] }>(API.admin.users);
    users.value = data.users || [];
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  } finally {
    loading.value = false;
  }
}

async function submitCreate() {
  const username = createForm.username.trim();
  if (!username) {
    message.warning("Enter a username");
    return;
  }
  if (username.toLowerCase() === "admin") {
    message.warning("Username “admin” is reserved for the root account");
    return;
  }
  saving.value = true;
  try {
    const data = await api<{ generatedPassword?: string }>(API.admin.users, {
      method: "POST",
      body: JSON.stringify({
        username,
        displayName: createForm.displayName.trim() || username,
        role: createForm.role,
      }),
    });
    createOpen.value = false;
    if (data.generatedPassword) {
      showCredential(username, data.generatedPassword);
    }
    message.success("User created");
    await load();
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  } finally {
    saving.value = false;
  }
}

async function submitEdit() {
  const u = editingUser.value;
  if (!u) return;
  saving.value = true;
  try {
    await api(API.admin.user(u.id), {
      method: "PATCH",
      body: JSON.stringify({
        displayName: editForm.displayName.trim(),
        role: editForm.role,
      }),
    });
    message.success("User updated");
    editOpen.value = false;
    await load();
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  } finally {
    saving.value = false;
  }
}

async function resetPassword(u: AdminUser) {
  saving.value = true;
  try {
    const data = await api<{ generatedPassword?: string }>(
      API.admin.userPassword(u.id),
      { method: "PUT", body: JSON.stringify({}) },
    );
    if (data.generatedPassword) {
      showCredential(u.gitlabUsername, data.generatedPassword);
    }
    message.success("New password generated");
    await load();
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  } finally {
    saving.value = false;
  }
}

function confirmResetPassword(u: AdminUser) {
  Modal.confirm({
    title: "Generate new password?",
    content: `@${u.gitlabUsername} will be signed out. The password is shown once for you to copy.`,
    okText: "Generate",
    cancelText: "Cancel",
    onOk: () => resetPassword(u),
  });
}

async function disableUser(u: AdminUser) {
  saving.value = true;
  try {
    await api(API.admin.userDisable(u.id), { method: "POST" });
    message.success(`Disabled @${u.gitlabUsername}`);
    await load();
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  } finally {
    saving.value = false;
  }
}

async function enableUser(u: AdminUser) {
  saving.value = true;
  try {
    await api(API.admin.userEnable(u.id), { method: "POST" });
    message.success(`Re-enabled @${u.gitlabUsername}`);
    await load();
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  } finally {
    saving.value = false;
  }
}

async function deleteUser(u: AdminUser) {
  saving.value = true;
  try {
    await api(API.admin.user(u.id), { method: "DELETE" });
    message.success(`Permanently deleted @${u.gitlabUsername}`);
    await load();
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  } finally {
    saving.value = false;
  }
}

function confirmDisable(u: AdminUser) {
  Modal.confirm({
    title: "Disable user?",
    content: `@${u.gitlabUsername} will not be able to sign in.`,
    okText: "Disable",
    cancelText: "Cancel",
    onOk: () => disableUser(u),
  });
}

function confirmDelete(u: AdminUser) {
  Modal.confirm({
    title: "Permanently delete user?",
    content: `This cannot be undone — @${u.gitlabUsername} will be removed.`,
    okType: "danger",
    okText: "Delete",
    cancelText: "Cancel",
    onOk: () => deleteUser(u),
  });
}

function onUserAction(key: string, record: AdminUser) {
  if (isProtected(record)) {
    message.warning("Root admin account cannot be edited");
    return;
  }
  if (key === "edit") openEdit(record);
  else if (key === "password") confirmResetPassword(record);
  else if (key === "disable") confirmDisable(record);
  else if (key === "enable") void enableUser(record);
  else if (key === "delete") confirmDelete(record);
}

function onTableChange(pagination: { current?: number; pageSize?: number }) {
  if (pagination.current != null) page.value = pagination.current;
  if (pagination.pageSize != null) pageSize.value = pagination.pageSize;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

onMounted(() => {
  void load();
});
</script>

<template>
  <div class="faw-admin-page">
    <header class="faw-admin-page__head">
      <div>
        <h1 class="faw-admin-page__title">Users</h1>
        <p class="faw-admin-page__desc">
          Create accounts, assign roles, and regenerate passwords. Chatbox column shows Project Chat message totals (including soft-deleted).
        </p>
      </div>
      <a-button type="primary" size="small" :loading="loading" @click="openCreate">
        + User
      </a-button>
    </header>

    <div class="faw-admin-stats">
      <div class="faw-admin-stat">
        <span class="faw-admin-stat__n">{{ stats.total }}</span>
        <span class="faw-admin-stat__l">Total</span>
      </div>
      <div class="faw-admin-stat faw-admin-stat--ok">
        <span class="faw-admin-stat__n">{{ stats.active }}</span>
        <span class="faw-admin-stat__l">Active</span>
      </div>
      <div class="faw-admin-stat faw-admin-stat--muted">
        <span class="faw-admin-stat__n">{{ stats.disabled }}</span>
        <span class="faw-admin-stat__l">Disabled</span>
      </div>
    </div>

    <div class="faw-admin-toolbar">
      <a-input
        v-model:value="search"
        allow-clear
        placeholder="Search username, display name, role…"
        class="faw-admin-toolbar__search"
      />
      <label class="faw-admin-toolbar__check">
        <input v-model="showDisabled" type="checkbox" />
        Show disabled users
      </label>
    </div>

    <a-table
      class="faw-admin-users-table"
      size="small"
      row-key="id"
      :columns="columns"
      :data-source="filteredUsers"
      :loading="loading"
      :scroll="{ x: 980 }"
      :pagination="{
        current: page,
        pageSize,
        total: filteredUsers.length,
        showSizeChanger: true,
        pageSizeOptions: ['10', '20', '50'],
        showTotal: (total: number) => `${total} users`,
      }"
      :row-class-name="(record: AdminUser) => (record.disabled ? 'faw-admin-users-table__row--off' : '')"
      @change="onTableChange"
    >
      <template #emptyText>
        <div class="faw-admin-empty py-8">
          <p class="mb-3">No users match.</p>
          <a-button type="primary" size="small" @click="openCreate">+ User</a-button>
        </div>
      </template>

      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'user'">
          <div class="min-w-0">
            <span class="font-semibold text-ink">
              @{{ (record as AdminUser).gitlabUsername }}
            </span>
            <span
              v-if="isSelf(record as AdminUser)"
              class="ml-1.5 text-[11px] text-accent"
            >
              (you)
            </span>
            <a-tag
              v-if="(record as AdminUser).isRootAdmin"
              class="!m-0 !ml-1.5 align-middle"
              color="blue"
            >
              Root admin
            </a-tag>
            <div
              v-if="(record as AdminUser).displayName"
              class="text-xs text-ink-muted mt-0.5 truncate"
            >
              {{ (record as AdminUser).displayName }}
            </div>
          </div>
        </template>

        <template v-else-if="column.key === 'roles'">
          <a-tag
            :color="
              primaryRole(record as AdminUser) === 'admin'
                ? 'blue'
                : primaryRole(record as AdminUser) === 'devops'
                  ? 'green'
                  : 'default'
            "
          >
            {{ ROLE_LABELS[primaryRole(record as AdminUser)] }}
          </a-tag>
        </template>

        <template v-else-if="column.key === 'chatbox'">
          <a-tooltip
            :title="
              chatboxUsageTitle(record as AdminUser)
            "
          >
            <div class="leading-tight">
              <span class="font-mono text-sm text-ink font-semibold">
                {{ (record as AdminUser).baChatMessageCount ?? 0 }}
              </span>
              <span class="text-[11px] text-ink-muted ml-1">msgs</span>
              <div class="text-[10px] text-ink-faint">
                {{ (record as AdminUser).baChatThreadCount ?? 0 }} threads
                <template
                  v-if="((record as AdminUser).baChatMessageDeletedCount ?? 0) > 0"
                >
                  · {{ (record as AdminUser).baChatMessageDeletedCount }} deleted
                </template>
              </div>
            </div>
          </a-tooltip>
        </template>

        <template v-else-if="column.key === 'status'">
          <a-tag :color="(record as AdminUser).disabled ? 'red' : 'green'">
            {{ (record as AdminUser).disabled ? "Disabled" : "Active" }}
          </a-tag>
        </template>

        <template v-else-if="column.key === 'password'">
          <span class="text-xs text-ink-muted">
            {{ (record as AdminUser).hasPassword ? "Set" : "Not set" }}
          </span>
        </template>

        <template v-else-if="column.key === 'updatedAt'">
          <span class="font-mono text-xs text-ink-muted">
            {{ formatDate((record as AdminUser).updatedAt) }}
          </span>
        </template>

        <template v-else-if="column.key === 'actions'">
          <span
            v-if="isProtected(record as AdminUser)"
            class="text-xs text-ink-muted"
            title="Root admin — cannot edit"
          >
            —
          </span>
          <a-dropdown v-else :trigger="['click']">
            <a-button size="small" type="text" class="!px-1.5">
              <MoreOutlined />
            </a-button>
            <template #overlay>
              <a-menu
                @click="(info: { key: string | number }) => onUserAction(String(info.key), record as AdminUser)"
              >
                <a-menu-item key="edit" :disabled="(record as AdminUser).disabled">
                  Edit
                </a-menu-item>
                <a-menu-item key="password" :disabled="(record as AdminUser).disabled">
                  Generate password
                </a-menu-item>
                <template v-if="!isSelf(record as AdminUser)">
                  <a-menu-divider />
                  <a-menu-item
                    v-if="!(record as AdminUser).disabled"
                    key="disable"
                  >
                    Disable
                  </a-menu-item>
                  <a-menu-item v-else key="enable">
                    Re-enable
                  </a-menu-item>
                  <a-menu-divider />
                  <a-menu-item key="delete" danger>
                    Delete permanently
                  </a-menu-item>
                </template>
              </a-menu>
            </template>
          </a-dropdown>
        </template>
      </template>
    </a-table>

    <a-modal
      v-model:open="createOpen"
      title="Create user"
      :confirm-loading="saving"
      ok-text="Create"
      cancel-text="Cancel"
      @ok="submitCreate"
    >
      <div class="space-y-3 py-2">
        <p class="text-sm text-ink-muted m-0">
          Password is generated automatically and shown once after create so you can copy it.
        </p>
        <label class="flex flex-col gap-1 text-sm">
          <span class="text-ink-muted">Username</span>
          <a-input
            v-model:value="createForm.username"
            placeholder="khoadev"
            autocomplete="off"
          />
        </label>
        <label class="flex flex-col gap-1 text-sm">
          <span class="text-ink-muted">Display name</span>
          <a-input
            v-model:value="createForm.displayName"
            placeholder="Optional"
          />
        </label>
        <label class="flex flex-col gap-1 text-sm">
          <span class="text-ink-muted">Role</span>
          <a-select
            v-model:value="createForm.role"
            :options="roleOptions"
            class="w-full"
          />
        </label>
      </div>
    </a-modal>

    <a-modal
      v-model:open="editOpen"
      :title="`Edit @${editingUser?.gitlabUsername}`"
      :confirm-loading="saving"
      ok-text="Save"
      cancel-text="Cancel"
      @ok="submitEdit"
    >
      <div class="space-y-3 py-2">
        <label class="flex flex-col gap-1 text-sm">
          <span class="text-ink-muted">Display name</span>
          <a-input v-model:value="editForm.displayName" />
        </label>
        <label class="flex flex-col gap-1 text-sm">
          <span class="text-ink-muted">Role</span>
          <a-select
            v-model:value="editForm.role"
            :options="roleOptions"
            class="w-full"
          />
        </label>
      </div>
    </a-modal>

    <a-modal
      v-model:open="credModal.open"
      title="Temporary password"
      :footer="null"
    >
      <div class="space-y-3 py-1">
        <p class="text-sm text-ink-muted m-0">
          Copy and share with <strong>@{{ credModal.username }}</strong> — shown this time only.
        </p>
        <div class="flex items-center gap-2">
          <code
            class="flex-1 px-3 py-2 rounded-md border border-line bg-surface font-mono text-sm break-all"
          >
            {{ credModal.password }}
          </code>
          <a-button type="primary" size="small" @click="copyCredential">
            <CopyOutlined />
          </a-button>
        </div>
      </div>
    </a-modal>
  </div>
</template>
