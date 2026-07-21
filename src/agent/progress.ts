import type { SDKMessage } from "@cursor/sdk";

export type ProgressLine = {
  id: number;
  at: string;
  kind: string;
  text: string;
};

const MAX_LINES = 400;
const buffers = new Map<string, ProgressLine[]>();
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
    default:
      break;
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
