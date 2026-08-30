import type { SDKMessage } from "@cursor/sdk";
import { publishRealtime } from "../realtime/hub.js";

/** Fixed estimate for context % UI (SDK has no remaining-% API). */
const CONTEXT_WINDOW_TOKENS = 200_000;

export type ProgressKind =
  | "prompt"
  | "thinking"
  | "assistant"
  | "status"
  | "usage"
  | "tool"
  | "task"
  | "system";

export type ProgressLine = {
  id: number;
  at: string;
  kind: ProgressKind;
  text: string;
};

export type JobTokenSnapshot = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  lastInputTokens: number;
  contextWindow: number;
  contextPct: number;
  updatedAt: string;
};

const MAX_LINES = 400;
const EVICT_AT = Math.ceil(MAX_LINES * 1.5);
const PRESERVE_MAX = 16_000;
const COMPACT_MAX = 2000;
/** Coalesced assistant/thinking SSE — buffer updates immediately; publish is throttled. */
export const PROGRESS_PUBLISH_MS = 80;

const buffers = new Map<string, ProgressLine[]>();
const tokenByJob = new Map<string, JobTokenSnapshot>();
const pendingPublish = new Map<string, ReturnType<typeof setTimeout>>();
let seq = 0;

function cancelPendingPublish(jobId: string): void {
  const timer = pendingPublish.get(jobId);
  if (!timer) return;
  clearTimeout(timer);
  pendingPublish.delete(jobId);
}

/** Push any throttled coalesced line so SSE is not left 80ms behind. */
function flushPendingPublish(jobId: string): void {
  if (!pendingPublish.has(jobId)) return;
  cancelPendingPublish(jobId);
  const list = buffers.get(jobId);
  const last = list?.[list.length - 1];
  if (!last) return;
  publishRealtime({
    type: "progress",
    jobId,
    line: { ...last },
    live: true,
  });
}

function scheduleCoalescedPublish(jobId: string, line: ProgressLine): void {
  if (pendingPublish.has(jobId)) return;
  pendingPublish.set(
    jobId,
    setTimeout(() => {
      pendingPublish.delete(jobId);
      publishRealtime({
        type: "progress",
        jobId,
        line: { ...line },
        live: true,
      });
    }, PROGRESS_PUBLISH_MS),
  );
}

/**
 * Collapse `\n{3,}` only at the concat boundary. Each delta is already
 * normalized; a full-string replace on a 16k line every token is O(n²).
 */
function joinAtBoundary(prev: string, next: string): string {
  let trail = 0;
  while (
    trail < prev.length &&
    prev.charCodeAt(prev.length - 1 - trail) === 10
  ) {
    trail++;
  }
  let lead = 0;
  while (lead < next.length && next.charCodeAt(lead) === 10) lead++;
  if (trail + lead < 3) return prev + next;
  return `${prev.slice(0, prev.length - trail)}\n\n${next.slice(lead)}`;
}

export function clearJobProgress(jobId: string): void {
  cancelPendingPublish(jobId);
  buffers.set(jobId, []);
}

export function appendJobProgress(
  jobId: string | undefined,
  kind: ProgressKind,
  text: string,
): void {
  if (!jobId) return;
  const preserveBreaks =
    kind === "prompt" || kind === "thinking" || kind === "assistant";
  const maxLen = preserveBreaks ? PRESERVE_MAX : COMPACT_MAX;
  // Stream deltas already include their own spaces / punctuation. Do not trim
  // assistant/thinking chunks — trim() + a guessed inter-token space turns
  // `main`+`.js`, `Đ`+`ã`, `#145`+`95` into `main .js` / `Đ ã` / `# 145 95`.
  let line = preserveBreaks
    ? text
        .replace(/\r\n/g, "\n")
        .replace(/[^\S\n]+/g, " ")
        .replace(/\n{3,}/g, "\n\n")
    : text.replace(/\s+/g, " ").trim();
  if (!line) return;
  let list = buffers.get(jobId);
  if (!list) {
    list = [];
    buffers.set(jobId, list);
  }
  const last = list[list.length - 1];
  // Coalesce consecutive assistant/thinking chunks into one growing line
  if (
    last &&
    (kind === "assistant" || kind === "thinking") &&
    last.kind === kind
  ) {
    last.at = new Date().toISOString();
    if (last.text.length < maxLen) {
      const joined = joinAtBoundary(last.text, line);
      last.text = joined.length > maxLen ? joined.slice(0, maxLen) : joined;
    }
    scheduleCoalescedPublish(jobId, last);
    return;
  }
  if (preserveBreaks) {
    line = line.replace(/^\n+/, "");
    if (!line) return;
  }
  flushPendingPublish(jobId);
  const entry: ProgressLine = {
    id: ++seq,
    at: new Date().toISOString(),
    kind,
    text: line.slice(0, maxLen),
  };
  list.push(entry);
  if (list.length > EVICT_AT) {
    list.splice(0, list.length - MAX_LINES);
  }
  publishRealtime({
    type: "progress",
    jobId,
    line: { ...entry },
    live: true,
  });
}

/** Log full prompt being sent to Cursor (Progress tab). */
export function appendPromptSending(
  jobId: string | undefined,
  prompt: string,
): void {
  const body = String(prompt || "").trim();
  if (!body) {
    appendJobProgress(jobId, "status", "Đang gửi prompt… (trống)");
    return;
  }
  const truncated =
    body.length > 15_500
      ? `${body.slice(0, 15_500)}\n\n… (còn ${body.length - 15_500} ký tự)`
      : body;
  appendJobProgress(
    jobId,
    "prompt",
    `Đang gửi prompt (${body.length} ký tự):\n\n${truncated}`,
  );
}

function summarizeToolArgs(name: string, args: unknown): string {
  if (!args || typeof args !== "object") return name;
  const a = args as Record<string, unknown>;
  if (typeof a.command === "string") return `${name}: ${a.command.slice(0, 160)}`;
  if (typeof a.path === "string") return `${name}: ${a.path}`;
  if (typeof a.file_path === "string") return `${name}: ${a.file_path}`;
  if (typeof a.pattern === "string") return `${name}: ${a.pattern}`;
  if (typeof a.query === "string") return `${name}: ${a.query.slice(0, 120)}`;
  if (typeof a.target_directory === "string")
    return `${name}: ${a.target_directory}`;
  return name;
}

type UsageLike = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
};

/** Best-effort context fill % from last-turn inputTokens / fixed window. */
export function recordTokenUsage(
  jobId: string | undefined,
  usage: UsageLike | undefined | null,
  opts?: { lastTurnInput?: number },
): JobTokenSnapshot | null {
  if (!jobId || !usage) return null;
  const window = CONTEXT_WINDOW_TOKENS;
  const inputTokens = Number(usage.inputTokens) || 0;
  const outputTokens = Number(usage.outputTokens) || 0;
  const totalTokens =
    Number(usage.totalTokens) ||
    inputTokens +
      outputTokens +
      (Number(usage.cacheReadTokens) || 0) +
      (Number(usage.cacheWriteTokens) || 0);
  const lastInput =
    opts?.lastTurnInput != null && opts.lastTurnInput > 0
      ? opts.lastTurnInput
      : inputTokens;
  const contextPct = Math.min(
    100,
    Math.round((lastInput / window) * 1000) / 10,
  );
  const snap: JobTokenSnapshot = {
    inputTokens,
    outputTokens,
    totalTokens,
    lastInputTokens: lastInput,
    contextWindow: window,
    contextPct,
    updatedAt: new Date().toISOString(),
  };
  tokenByJob.set(jobId, snap);
  const short = (n: number) =>
    n >= 1_000_000
      ? `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`
      : n >= 1000
        ? `${Math.round(n / 1000)}k`
        : String(n);
  appendJobProgress(
    jobId,
    "usage",
    `%${contextPct} - ${short(lastInput)}/${short(window)}`,
  );
  return snap;
}

export function getJobTokenUsage(jobId: string): JobTokenSnapshot | null {
  return tokenByJob.get(jobId) ?? null;
}

export function appendSdkMessage(
  jobId: string | undefined,
  message: SDKMessage,
): void {
  if (!jobId) return;
  switch (message.type) {
    case "status":
      appendJobProgress(
        jobId,
        "status",
        message.message
          ? `${message.status} — ${message.message}`
          : message.status,
      );
      break;
    case "thinking":
      appendJobProgress(jobId, "thinking", message.text);
      break;
    case "assistant": {
      const texts = message.message.content
        .filter((b): b is { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text)
        .join("");
      if (texts) appendJobProgress(jobId, "assistant", texts);
      for (const b of message.message.content) {
        if (b.type === "tool_use") {
          appendJobProgress(
            jobId,
            "tool",
            summarizeToolArgs(b.name, b.input),
          );
        }
      }
      break;
    }
    case "tool_call": {
      const label = summarizeToolArgs(message.name, message.args);
      const suffix =
        message.status === "running"
          ? "…"
          : message.status === "error"
            ? " ✗"
            : " ✓";
      appendJobProgress(jobId, "tool", `${label}${suffix}`);
      break;
    }
    case "task":
      if (message.text || message.status) {
        appendJobProgress(
          jobId,
          "task",
          [message.status, message.text].filter(Boolean).join(" — "),
        );
      }
      break;
    case "system":
      appendJobProgress(jobId, "system", `init · ${message.run_id}`);
      break;
    default: {
      const raw = message as { type?: string; usage?: UsageLike };
      if (raw.type === "usage" && raw.usage) {
        recordTokenUsage(jobId, raw.usage, {
          lastTurnInput: Number(raw.usage.inputTokens) || undefined,
        });
      }
      break;
    }
  }
}

export function getJobProgress(
  jobId: string,
  afterId = 0,
): { lines: ProgressLine[]; latestId: number } {
  const list = buffers.get(jobId) ?? [];
  const lines = afterId > 0 ? list.filter((l) => l.id > afterId) : list;
  const latestId = list.length ? list[list.length - 1]!.id : afterId;
  return { lines, latestId };
}
