<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import Editor from "@toast-ui/editor";
import "@toast-ui/editor/dist/toastui-editor.css";
import "@toast-ui/editor/dist/theme/toastui-editor-dark.css";
import { useThemeStore } from "@/stores/theme";

const props = defineProps<{
  modelValue: string;
  placeholder?: string;
}>();

const emit = defineEmits<{
  "update:modelValue": [string];
}>();

const themeStore = useThemeStore();
const rootRef = ref<HTMLElement | null>(null);
let editor: Editor | null = null;

function editorTheme(): "dark" | "default" {
  return themeStore.mode === "dark" ? "dark" : "default";
}

function syncOut() {
  if (!editor) return;
  emit("update:modelValue", editor.getMarkdown().trim());
}

function mountEditor() {
  if (!rootRef.value) return;
  const value = editor?.getMarkdown() ?? props.modelValue;
  editor?.destroy();
  editor = new Editor({
    el: rootRef.value,
    height: "450px",
    initialEditType: "wysiwyg",
    previewStyle: "tab",
    placeholder: props.placeholder || "Mô tả task cho Dev…",
    initialValue: value || "",
    theme: editorTheme(),
    usageStatistics: false,
    toolbarItems: [
      ["heading", "bold", "italic", "strike"],
      ["hr", "quote"],
      ["ul", "ol", "task"],
      ["table", "link"],
      ["code", "codeblock"],
    ],
    events: {
      change: syncOut,
    },
  });
}

onMounted(mountEditor);

watch(
  () => themeStore.mode,
  () => {
    mountEditor();
  },
);

watch(
  () => props.modelValue,
  (v) => {
    if (!editor) return;
    const cur = editor.getMarkdown().trim();
    if ((v || "").trim() !== cur) editor.setMarkdown(v || "");
  },
);

onBeforeUnmount(() => {
  editor?.destroy();
  editor = null;
});
</script>

<template>
  <div
    ref="rootRef"
    class="ba-issue-editor-host"
    :data-editor-theme="themeStore.mode"
  />
</template>
