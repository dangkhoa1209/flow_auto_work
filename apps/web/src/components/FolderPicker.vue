<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { message } from "ant-design-vue";
import {
  FolderOutlined,
  FolderOpenOutlined,
  ArrowUpOutlined,
  HomeOutlined,
  CheckOutlined,
} from "@ant-design/icons-vue";
import { api } from "@/api/client";

const props = defineProps<{
  open: boolean;
  modelValue?: string;
}>();

const emit = defineEmits<{
  "update:open": [boolean];
  "update:modelValue": [string];
  select: [string];
}>();

const loading = ref(false);
const currentPath = ref("");
const parent = ref<string | null>(null);
const home = ref("");
const isGitRepo = ref(false);
const entries = ref<Array<{ name: string; path: string }>>([]);

const visible = computed({
  get: () => props.open,
  set: (v: boolean) => emit("update:open", v),
});

async function load(path?: string) {
  loading.value = true;
  try {
    const q = path ? `?path=${encodeURIComponent(path)}` : "";
    const data = await api<{
      path: string;
      parent: string | null;
      home: string;
      entries: Array<{ name: string; path: string }>;
      isGitRepo: boolean;
    }>(`/api/fs/browse${q}`);
    currentPath.value = data.path;
    parent.value = data.parent;
    home.value = data.home;
    entries.value = data.entries || [];
    isGitRepo.value = Boolean(data.isGitRepo);
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  } finally {
    loading.value = false;
  }
}

watch(
  () => props.open,
  (v) => {
    if (v) {
      void load(props.modelValue?.trim() || undefined);
    }
  },
);

function goParent() {
  if (parent.value) void load(parent.value);
}

function goHome() {
  if (home.value) void load(home.value);
}

function enter(p: string) {
  void load(p);
}

function confirm() {
  emit("update:modelValue", currentPath.value);
  emit("select", currentPath.value);
  visible.value = false;
}
</script>

<template>
  <a-modal
    v-model:open="visible"
    title="Choose repo folder"
    :width="560"
    ok-text="Select this folder"
    cancel-text="Cancel"
    @ok="confirm"
  >
    <div class="space-y-3">
      <div class="flex gap-2 items-center">
        <a-button size="small" :disabled="!parent" @click="goParent">
          <template #icon><ArrowUpOutlined /></template>
          Up
        </a-button>
        <a-button size="small" @click="goHome">
          <template #icon><HomeOutlined /></template>
          Home
        </a-button>
        <a-tag v-if="isGitRepo" color="success" class="m-0">
          <CheckOutlined /> Git repo
        </a-tag>
      </div>
      <a-input :value="currentPath" readonly class="font-mono text-xs" />
      <a-spin :spinning="loading">
        <div
          class="max-h-72 overflow-auto rounded-xl border border-line bg-surface-soft"
        >
          <button
            v-for="e in entries"
            :key="e.path"
            type="button"
            class="w-full text-left px-3 py-2 flex items-center gap-2 hover:bg-accent-soft border-b border-line text-sm text-ink-soft"
            @click="enter(e.path)"
            @dblclick="enter(e.path)"
          >
            <FolderOutlined class="text-accent" />
            <span class="truncate">{{ e.name }}</span>
          </button>
          <div
            v-if="!entries.length && !loading"
            class="text-center text-ink-faint text-sm py-8"
          >
            Empty folder
          </div>
        </div>
      </a-spin>
      <p class="text-xs text-ink-faint m-0">
        Click a folder to open · click «Select this folder» when the repo path is correct.
      </p>
    </div>
    <template #footer>
      <a-button @click="visible = false">Cancel</a-button>
      <a-button type="primary" @click="confirm">
        <template #icon><FolderOpenOutlined /></template>
        Select this folder
      </a-button>
    </template>
  </a-modal>
</template>
