<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { getAccessToken, getProjectId } from "@/api/tokenStorage";
import { refreshAccessToken } from "@/api/client";

const props = defineProps<{
  /** Remount / reconnect when this flips true while visible */
  active?: boolean;
}>();

const hostEl = ref<HTMLElement | null>(null);
const statusText = ref("Connecting…");
const cwdText = ref("");
let term: Terminal | null = null;
let fit: FitAddon | null = null;
let ws: WebSocket | null = null;
let ro: ResizeObserver | null = null;
let disposed = false;

function wsUrl(cols: number, rows: number): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const token = getAccessToken() || "";
  const project = getProjectId() || "";
  const q = new URLSearchParams({
    access_token: token,
    project,
    cols: String(cols),
    rows: String(rows),
  });
  return `${proto}//${location.host}/api/terminal/ws?${q.toString()}`;
}

function sendJson(payload: unknown) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function fitAndResize() {
  if (!fit || !term) return;
  try {
    fit.fit();
  } catch {
    /* host not visible yet */
  }
  sendJson({ type: "resize", cols: term.cols, rows: term.rows });
}

async function connect() {
  if (disposed || !term) return;
  statusText.value = "Connecting…";

  try {
    await refreshAccessToken().catch(() => undefined);
  } catch {
    /* ignore */
  }

  if (!getAccessToken() || !getProjectId()) {
    statusText.value = "Login + chọn project trước";
    term.writeln("\r\n\x1b[31mCần đăng nhập và chọn project.\x1b[0m\r\n");
    return;
  }

  if (ws) {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
    ws = null;
  }

  const socket = new WebSocket(wsUrl(term.cols, term.rows));
  ws = socket;

  socket.onopen = () => {
    statusText.value = "Connected";
    fitAndResize();
  };

  socket.onmessage = (ev) => {
    if (typeof ev.data !== "string" || !term) return;
    try {
      const msg = JSON.parse(ev.data) as {
        type?: string;
        data?: string;
        cwd?: string;
        message?: string;
      };
      if (msg.type === "out" && typeof msg.data === "string") {
        term.write(msg.data);
        return;
      }
      if (msg.type === "ready") {
        cwdText.value = msg.cwd || "";
        statusText.value = "Ready";
        return;
      }
      if (msg.type === "error") {
        statusText.value = msg.message || "Error";
        term.writeln(`\r\n\x1b[31m${msg.message || "error"}\x1b[0m\r\n`);
        return;
      }
      if (msg.type === "exit") {
        statusText.value = "Shell exited";
        term.writeln("\r\n\x1b[33m[shell exited]\x1b[0m\r\n");
      }
    } catch {
      term.write(ev.data);
    }
  };

  socket.onclose = () => {
    if (ws === socket) ws = null;
    if (!disposed) statusText.value = "Disconnected";
  };

  socket.onerror = () => {
    statusText.value = "WS error";
  };
}

function boot() {
  if (!hostEl.value || term) return;
  const isDark =
    document.documentElement.dataset.theme !== "light";
  term = new Terminal({
    cursorBlink: true,
    fontSize: 12,
    fontFamily: "IBM Plex Mono, ui-monospace, Menlo, monospace",
    theme: isDark
      ? {
          background: "#0d1117",
          foreground: "#e6edf3",
          cursor: "#58a6ff",
        }
      : {
          background: "#f6f8fa",
          foreground: "#1f2328",
          cursor: "#0969da",
        },
    allowProposedApi: true,
  });
  fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon());
  term.open(hostEl.value);
  term.onData((data) => {
    sendJson({ type: "input", data });
  });
  void nextTick(() => {
    fitAndResize();
    void connect();
  });

  if (typeof ResizeObserver !== "undefined" && hostEl.value) {
    ro = new ResizeObserver(() => fitAndResize());
    ro.observe(hostEl.value);
  }
}

function teardown() {
  disposed = true;
  ro?.disconnect();
  ro = null;
  try {
    ws?.close();
  } catch {
    /* ignore */
  }
  ws = null;
  try {
    term?.dispose();
  } catch {
    /* ignore */
  }
  term = null;
  fit = null;
}

onMounted(() => {
  disposed = false;
  boot();
});

onUnmounted(() => teardown());

watch(
  () => props.active,
  (on) => {
    if (on) {
      void nextTick(() => fitAndResize());
    }
  },
);

function reconnect() {
  if (!term) return;
  term.clear();
  void connect();
}
</script>

<template>
  <div class="faw-repo-term flex flex-col min-h-0 h-full">
    <div class="faw-repo-term__bar shrink-0">
      <span class="faw-repo-term__status">{{ statusText }}</span>
      <span
        v-if="cwdText"
        class="faw-repo-term__cwd"
        :title="cwdText"
        >{{ cwdText }}</span
      >
      <span class="flex-1" />
      <button type="button" class="faw-btn" @click="reconnect">Reconnect</button>
    </div>
    <div ref="hostEl" class="faw-repo-term__host flex-1 min-h-0" />
  </div>
</template>

<style scoped>
.faw-repo-term__bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px;
  border-bottom: 1px solid var(--app-border);
  font: 500 11px var(--font-ui);
  color: var(--app-ink-muted);
  background: var(--app-panel-soft, rgba(255, 255, 255, 0.02));
}
.faw-repo-term__cwd {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 55%;
  font-family: var(--font-mono, ui-monospace, monospace);
  opacity: 0.85;
}
.faw-repo-term__host {
  padding: 4px;
  background: #0d1117;
}
:root[data-theme="light"] .faw-repo-term__host {
  background: #f6f8fa;
}
.faw-repo-term__host :deep(.xterm) {
  height: 100%;
  padding: 4px;
}
.faw-repo-term__host :deep(.xterm-viewport) {
  overflow-y: auto !important;
}
</style>
