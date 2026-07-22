import type { SDKMessage } from "@cursor/sdk";
import { getConfig } from "../config.js";

export type ProgressLine = {
  id: number;
  at: string;
  kind: string;
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
const buffers = new Map<string, ProgressLine[]>();
const tokenByJob = new Map<string, JobTokenSnapshot>();
let seq = 0;

export function clearJobProgress(jobId: string): void {
  buffers.set(jobId, []);
}

export function appendJobProgress(
  jobId: string | undefined,
  kind: string,
  text: string,
): void {
  if (!jobId) return;
  const line = text.replace(/\s+/g, " ").trim();
  if (!line) return;
  const list = buffers.get(jobId) ?? [];
  const last = list[list.length - 1];
  // Coalesce consecutive assistant/thinking chunks into one growing line
  if (last && (kind === "assistant" || kind === "thinking") && last.kind === kind) {
    last.text = `${last.text}${line}`.slice(0, 4000);
    last.at = new Date().toISOString();
    buffers.set(jobId, list);
    return;
  }
  list.push({
    id: ++seq,
    at: new Date().toISOString(),
    kind,
    text: line.slice(0, 2000),
  });
  while (list.length > MAX_LINES) list.shift();
  buffers.set(jobId, list);
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

/** Best-effort context fill % from last-turn inputTokens / configured window. */
export function recordTokenUsage(
  jobId: string | undefined,
  usage: UsageLike | undefined | null,
  opts?: { lastTurnInput?: number },
): JobTokenSnapshot | null {
  if (!jobId || !usage) return null;
  const window = Math.max(1, getConfig().CURSOR_CONTEXT_WINDOW || 200_000);
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
  appendJobProgress(
    jobId,
    "usage",
    `tokens · window ~${contextPct}% (${lastInput.toLocaleString()}/${window.toLocaleString()} in) · total ${totalTokens.toLocaleString()}`,
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
      if (texts.trim()) appendJobProgress(jobId, "assistant", texts);
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
