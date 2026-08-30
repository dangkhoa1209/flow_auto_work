<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import type { BuildLogLine } from "@/api/devopsApi";

const props = defineProps<{
  lines: BuildLogLine[];
  buildId: string | null;
}>();

const hostEl = ref<HTMLElement | null>(null);
let term: Terminal | null = null;
let fit: FitAddon | null = null;
let ro: ResizeObserver | null = null;
let written = 0;
let lastBuildId: string | null = null;

function ansiLine(line: BuildLogLine): string {
  const text = line.text ?? "";
  if (line.stream === "stderr") return `\x1b[31m${text}\x1b[0m`;
  if (line.stream === "system") return `\x1b[36m${text}\x1b[0m`;
  return text;
}

function fitTerm() {
  if (!fit || !term) return;
  try {
    fit.fit();
  } catch {
    /* host not visible yet */
  }
}

function writeFrom(start: number) {
  if (!term) return;
  if (start >= props.lines.length) return;
  const chunk: string[] = [];
  for (let i = start; i < props.lines.length; i++) {
    chunk.push(ansiLine(props.lines[i]));
  }
  term.write(`${chunk.join("\r\n")}\r\n`);
  written = props.lines.length;
}

function resetAndReplay() {
  if (!term) return;
  term.reset();
  written = 0;
  lastBuildId = props.buildId;
  if (!props.lines.length) {
    written = 0;
    return;
  }
  writeFrom(0);
}

function clear() {
  if (!term) return;
  term.reset();
  written = props.lines.length;
  lastBuildId = props.buildId;
}

function boot() {
  if (!hostEl.value || term) return;
  term = new Terminal({
    cursorBlink: true,
    disableStdin: true,
    convertEol: true,
    fontSize: 12,
    fontFamily: "IBM Plex Mono, ui-monospace, Menlo, Consolas, monospace",
    theme: {
      background: "#0d1117",
      foreground: "#e6edf3",
      cursor: "#58a6ff",
      black: "#484f58",
      red: "#ff7b72",
      green: "#3fb950",
      yellow: "#d29922",
      blue: "#58a6ff",
      magenta: "#bc8cff",
      cyan: "#39c5cf",
      white: "#b1bac4",
      brightBlack: "#6e7681",
      brightRed: "#ffa198",
      brightGreen: "#56d364",
      brightYellow: "#e3b341",
      brightBlue: "#79c0ff",
      brightMagenta: "#d2a8ff",
      brightCyan: "#56d4dd",
      brightWhite: "#f0f6fc",
    },
    allowProposedApi: true,
  });
  fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon());
  term.open(hostEl.value);
  void nextTick(() => {
    fitTerm();
    resetAndReplay();
  });
  if (typeof ResizeObserver !== "undefined") {
    ro = new ResizeObserver(() => fitTerm());
    ro.observe(hostEl.value);
  }
}

onMounted(boot);

onUnmounted(() => {
  ro?.disconnect();
  ro = null;
  try {
    term?.dispose();
  } catch {
    /* ignore */
  }
  term = null;
  fit = null;
});

watch(
  () => props.buildId,
  (next, prev) => {
    if (next === prev) return;
    resetAndReplay();
  },
);

watch(
  () => props.lines.length,
  (len) => {
    if (!term) return;
    if (props.buildId !== lastBuildId) {
      resetAndReplay();
      return;
    }
    if (len < written) {
      resetAndReplay();
      return;
    }
    writeFrom(written);
  },
);

defineExpose({ clear, fitTerm });
</script>

<template>
  <div ref="hostEl" class="faw-build-term" />
</template>

<style scoped>
.faw-build-term {
  flex: 1;
  min-height: 0;
  height: 100%;
  background: #0d1117;
  padding: 8px 10px 4px;
}
.faw-build-term :deep(.xterm) {
  height: 100%;
}
.faw-build-term :deep(.xterm-viewport) {
  overflow-y: auto !important;
}
</style>
