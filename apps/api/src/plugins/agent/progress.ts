import type {
  ConversationStep,
  InteractionUpdate,
  SDKMessage,
} from "@cursor/sdk";
import { publishRealtime } from "../realtime/hub.js";
import { workSubagentLabel } from "../cursor/workSubagents.js";

/**
 * Nested subagent step (from SDK `tool-call-delta`.taskUpdate / NestedTaskUpdate,
 * stream agent_id, or Task conversationSteps).
 */
export type SubagentNestUpdate =
  | { type: "text-delta"; text: string }
  | { type: "thinking-delta"; text: string }
  | { type: "tool-call-started"; toolCall: unknown }
  | { type: "tool-call-completed"; toolCall: unknown };

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
/** Full Cursor plan-mode body from `createPlan` tool (not the clipped tool label). */
const capturedPlanByJob = new Map<string, string>();
/** First SDKMessage.agent_id for the job — later different ids are nested subagents. */
const rootAgentByJob = new Map<string, string>();
/** Subagent agent_ids already seen live (skip conversationSteps replay). */
const nestedAgentsSeenByJob = new Map<string, Set<string>>();
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
  capturedPlanByJob.delete(jobId);
  rootAgentByJob.delete(jobId);
  nestedAgentsSeenByJob.delete(jobId);
}

/** Full plan text from Cursor `createPlan` (if any) for this job run. */
export function getJobCapturedPlan(jobId: string): string | undefined {
  const t = capturedPlanByJob.get(jobId)?.trim();
  return t || undefined;
}

/**
 * Cursor plan mode writes the real plan into tool `createPlan` args.plan.
 * Process tool lines only keep a short hint — stash the full body for Chat.
 */
export function captureCreatePlanFromTool(
  jobId: string | undefined,
  name: string,
  args: unknown,
  opts?: { mirrorToProcess?: boolean },
): string | undefined {
  if (!jobId) return undefined;
  const a = asRecord(args);
  const display = resolveToolName(name, a);
  const isCreatePlan =
    /^createPlan$/i.test(name) ||
    /^createPlan$/i.test(display) ||
    /^create_plan$/i.test(name) ||
    /^create_plan$/i.test(display);
  if (!isCreatePlan) return undefined;
  const inner = a ? innerToolArgs(a) : null;
  const raw =
    (typeof inner?.plan === "string" && inner.plan) ||
    (typeof a?.plan === "string" && a.plan) ||
    "";
  const text = raw.trim();
  if (!text) return undefined;
  const prev = capturedPlanByJob.get(jobId) || "";
  if (text.length <= prev.length) return prev;
  capturedPlanByJob.set(jobId, text);
  if (opts?.mirrorToProcess !== false) {
    // Show full plan in Process while building (assistant coalesces).
    appendJobProgress(jobId, "assistant", text);
  }
  return text;
}

function tryCaptureCreatePlanFromToolCall(toolCall: unknown): {
  name: string;
  args: unknown;
} | null {
  if (!toolCall || typeof toolCall !== "object") return null;
  const tc = toolCall as { type?: string; name?: string; args?: unknown };
  const name =
    (typeof tc.type === "string" && tc.type) ||
    (typeof tc.name === "string" && tc.name) ||
    "";
  if (!name) return null;
  return { name, args: tc.args };
}

export function appendJobProgress(
  jobId: string | undefined,
  kind: ProgressKind,
  text: string,
): void {
  if (!jobId) return;
  const preserveBreaks =
    kind === "prompt" ||
    kind === "thinking" ||
    kind === "assistant" ||
    kind === "task";
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
  // Coalesce consecutive assistant/thinking/task (subagent text) chunks
  if (
    last &&
    (kind === "assistant" || kind === "thinking" || kind === "task") &&
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

/** Log that a request was sent to Cursor (Progress tab — no prompt body). */
export function appendPromptSending(
  jobId: string | undefined,
  prompt: string,
): void {
  const body = String(prompt || "").trim();
  if (!body) {
    appendJobProgress(jobId, "status", "Đã gửi yêu cầu (trống)");
    return;
  }
  appendJobProgress(jobId, "prompt", "Đã gửi yêu cầu");
}

function asRecord(v: unknown): Record<string, unknown> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  return v as Record<string, unknown>;
}

function asNonEmptyString(v: unknown): string | undefined {
  if (typeof v === "string") {
    const t = v.trim();
    return t || undefined;
  }
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  const rec = asRecord(v);
  if (!rec) return undefined;
  return (
    asNonEmptyString(rec.stringValue) ||
    asNonEmptyString(rec.string_value) ||
    asNonEmptyString(rec.value)
  );
}

function pickString(
  obj: Record<string, unknown> | null,
  keys: string[],
): string | undefined {
  if (!obj) return undefined;
  for (const k of keys) {
    const s = asNonEmptyString(obj[k]);
    if (s) return s;
  }
  return undefined;
}

function isGenericToolName(n: string): boolean {
  const k = n.toLowerCase().replace(/[_-]/g, "");
  return (
    k === "mcp" ||
    k === "unknown" ||
    k === "callmcptool" ||
    k === "customusertools"
  );
}

function stripCustomUserPrefix(n: string): string {
  return n.replace(/^custom-user-tools[_:-]*/i, "").trim() || n;
}

function innerToolArgs(
  a: Record<string, unknown>,
): Record<string, unknown> | null {
  for (const k of [
    "args",
    "toolArgs",
    "tool_args",
    "arguments",
    "input",
    "toolInput",
    "tool_input",
  ]) {
    const inner = a[k];
    const rec = asRecord(inner);
    if (rec) return rec;
    if (typeof inner === "string") {
      try {
        const parsed = JSON.parse(inner) as unknown;
        const fromJson = asRecord(parsed);
        if (fromJson) return fromJson;
      } catch {
        /* not JSON */
      }
    }
  }
  return null;
}

function resolveToolName(
  name: string,
  a: Record<string, unknown> | null,
): string {
  if (!a) return name;
  const nested =
    pickString(a, ["toolName", "tool_name"]) ||
    (isGenericToolName(name) ? pickString(a, ["name"]) : undefined);
  if (!nested || isGenericToolName(nested)) return name;
  return stripCustomUserPrefix(nested);
}

function hintFromArgs(a: Record<string, unknown> | null): string | undefined {
  if (!a) return undefined;
  const from = pickString(a, ["from"]);
  const to = pickString(a, ["to"]);
  if (from && to) return `${from} → ${to}`;
  return pickString(a, [
    "question",
    "concept",
    "command",
    "sql",
    "query",
    "path",
    "file_path",
    "pattern",
    "target_directory",
    "uri",
  ]);
}

function clipHint(hint: string, max: number): string {
  return hint.length > max ? `${hint.slice(0, max)}…` : hint;
}

function taskSubagentName(args: Record<string, unknown>): string {
  const st = args.subagentType;
  if (st && typeof st === "object") {
    const o = st as { name?: unknown; kind?: unknown };
    if (typeof o.name === "string" && o.name.trim()) return o.name.trim();
    if (typeof o.kind === "string" && o.kind.trim()) return o.kind.trim();
  }
  if (typeof args.subagent_type === "string" && args.subagent_type.trim()) {
    return args.subagent_type.trim();
  }
  return "subagent";
}

/** Cursor SDK custom tools stream as name "mcp"; unwrap toolName + inner args. */
function summarizeToolArgs(name: string, args: unknown): string {
  const a = asRecord(args);
  if (a && (name === "task" || name === "Task" || name === "agent")) {
    const label = workSubagentLabel(taskSubagentName(a));
    const desc =
      typeof a.description === "string"
        ? a.description.trim().slice(0, 140)
        : "";
    return desc ? `subagent · ${label}: ${desc}` : `subagent · ${label}`;
  }
  const display = resolveToolName(name, a);
  const inner = a ? innerToolArgs(a) : null;
  if (
    /^createPlan$/i.test(name) ||
    /^createPlan$/i.test(display) ||
    /^create_plan$/i.test(display)
  ) {
    const plan =
      (typeof inner?.plan === "string" && inner.plan.trim()) ||
      (typeof a?.plan === "string" && a.plan.trim()) ||
      "";
    if (plan) {
      const first = plan.split(/\r?\n/).find((l) => l.trim()) || plan;
      return `createPlan: ${clipHint(first.trim(), 100)}`;
    }
    return "createPlan";
  }
  const hint = hintFromArgs(inner) || hintFromArgs(a);
  if (!hint) return display;
  const max = display === "Shell" || name === "Shell" ? 160 : 120;
  return `${display}: ${clipHint(hint, max)}`;
}

function summarizeNestedToolCall(toolCall: unknown): string {
  if (!toolCall || typeof toolCall !== "object") return "tool";
  const tc = toolCall as { type?: string; name?: string; args?: unknown };
  const type =
    (typeof tc.type === "string" && tc.type) ||
    (typeof tc.name === "string" && tc.name) ||
    "tool";
  return summarizeToolArgs(type, tc.args);
}

function nestTag(id: string | undefined): string {
  const raw = (id || "sub").trim();
  return raw.slice(0, 8) || "sub";
}

function noteNestedAgent(jobId: string, agentId: string): void {
  let set = nestedAgentsSeenByJob.get(jobId);
  if (!set) {
    set = new Set();
    nestedAgentsSeenByJob.set(jobId, set);
  }
  set.add(agentId);
}

function trackRootAgent(
  jobId: string,
  agentId: string | undefined,
): { nested: boolean; tag: string } | null {
  if (!agentId) return null;
  const root = rootAgentByJob.get(jobId);
  if (!root) {
    rootAgentByJob.set(jobId, agentId);
    return null;
  }
  if (agentId === root) return null;
  noteNestedAgent(jobId, agentId);
  return { nested: true, tag: nestTag(agentId) };
}

/**
 * Nested subagent process lines (prefix `[sub …]` on tools).
 * Text deltas use kind `task` (no per-chunk prefix) so Process can coalesce.
 */
export function appendSubagentDelta(
  jobId: string | undefined,
  callId: string,
  update: SubagentNestUpdate,
): void {
  if (!jobId) return;
  const tag = nestTag(callId);
  switch (update.type) {
    case "text-delta":
      if (update.text) appendJobProgress(jobId, "task", update.text);
      break;
    case "thinking-delta":
      if (update.text) appendJobProgress(jobId, "thinking", update.text);
      break;
    case "tool-call-started":
      appendJobProgress(
        jobId,
        "tool",
        `[sub ${tag}] ${summarizeNestedToolCall(update.toolCall)}…`,
      );
      break;
    case "tool-call-completed":
      appendJobProgress(
        jobId,
        "tool",
        `[sub ${tag}] ${summarizeNestedToolCall(update.toolCall)} ✓`,
      );
      break;
    default:
      break;
  }
}

/** Replay nested toolCalls from Task result.conversationSteps (post-hoc). */
function expandTaskConversationSteps(
  jobId: string,
  callId: string,
  result: unknown,
): void {
  const rec = asRecord(result);
  if (!rec) return;
  const value =
    asRecord(rec.value) ||
    (rec.status === "success" ? rec : null) ||
    rec;
  const steps = value?.conversationSteps;
  if (!Array.isArray(steps) || steps.length === 0) return;
  const agentId =
    (typeof value?.agentId === "string" && value.agentId) ||
    (typeof rec.agentId === "string" && rec.agentId) ||
    callId;
  const seen = nestedAgentsSeenByJob.get(jobId);
  // Live tool-call-delta notes the Task callId; skip replay if we already streamed.
  if (seen?.has(agentId) || seen?.has(callId)) {
    return;
  }
  const tag = nestTag(agentId);
  let emitted = 0;
  for (const step of steps) {
    const s = asRecord(step);
    if (!s) continue;
    if (s.type === "toolCall" || s.type === "tool_call") {
      const tool = s.message ?? s.toolCall ?? s.tool_call ?? s;
      appendJobProgress(
        jobId,
        "tool",
        `[sub ${tag}] ${summarizeNestedToolCall(tool)} ✓`,
      );
      emitted++;
    } else if (s.type === "assistantMessage" || s.type === "assistant") {
      const msg = asRecord(s.message) || s;
      const text =
        (typeof msg?.text === "string" && msg.text) ||
        (typeof s.text === "string" && s.text) ||
        "";
      if (text.trim()) {
        appendJobProgress(jobId, "task", text.trim().slice(0, 2000));
        emitted++;
      }
    }
  }
  if (emitted > 0) noteNestedAgent(jobId, agentId);
}

/** Wire into Agent.send for /work — createPlan capture + live nest via tool-call-delta. */
export function workRunOnDelta(
  jobId: string | undefined,
):
  | undefined
  | ((args: { update: InteractionUpdate }) => void) {
  if (!jobId) return undefined;
  return ({ update }) => {
    // SDK ≥1.0.31: nested Task tools stream as tool-call-delta.taskUpdate.
    // Fallbacks: run.stream() with a different agent_id (appendSdkMessage),
    // Task conversationSteps / onStep / run.conversation() when live nest is thin.
    if (update.type === "tool-call-delta") {
      const delta = update as {
        callId?: string;
        taskUpdate?: SubagentNestUpdate;
      };
      if (delta.taskUpdate && delta.callId) {
        noteNestedAgent(jobId, delta.callId);
        appendSubagentDelta(jobId, delta.callId, delta.taskUpdate);
      }
      return;
    }
    if (
      update.type === "tool-call-started" ||
      update.type === "tool-call-completed" ||
      update.type === "partial-tool-call"
    ) {
      const tc = tryCaptureCreatePlanFromToolCall(
        (update as { toolCall?: unknown }).toolCall,
      );
      if (tc) {
        captureCreatePlanFromTool(jobId, tc.name, tc.args, {
          mirrorToProcess: update.type !== "partial-tool-call",
        });
      }
    }
  };
}

/**
 * send() onStep — expand nested Task conversationSteps (complements stream).
 * Does not re-emit every parent tool (stream already mirrors those).
 */
export function workRunOnStep(
  jobId: string | undefined,
):
  | undefined
  | ((args: { step: ConversationStep }) => void) {
  if (!jobId) return undefined;
  return ({ step }) => {
    expandTaskStepIfPresent(jobId, step);
  };
}

function expandTaskStepIfPresent(
  jobId: string,
  step: ConversationStep,
): void {
  const s = step as unknown as Record<string, unknown>;
  if (s.type !== "toolCall" && s.type !== "tool_call") return;
  const tool = s.message ?? s.toolCall ?? s.tool_call ?? s;
  const toolRec = asRecord(tool);
  if (!toolRec) return;
  const toolType =
    (typeof toolRec.type === "string" && toolRec.type) ||
    (typeof toolRec.name === "string" && toolRec.name) ||
    "";
  if (toolType !== "task" && toolType !== "Task" && toolType !== "agent") {
    return;
  }
  const result =
    toolRec.result ?? asRecord(toolRec.message)?.result ?? toolRec;
  const callId =
    (typeof toolRec.callId === "string" && toolRec.callId) ||
    (typeof toolRec.call_id === "string" && toolRec.call_id) ||
    "task";
  expandTaskConversationSteps(jobId, callId, result);
}

/**
 * Best-effort Process backfill from run.conversation() when live nest was thin.
 */
export async function appendRunConversationIfNeeded(
  jobId: string | undefined,
  run: { conversation?: () => Promise<unknown> },
): Promise<void> {
  if (!jobId || typeof run.conversation !== "function") return;
  if (nestedAgentsSeenByJob.get(jobId)?.size) return;
  try {
    const turns = await run.conversation();
    if (!Array.isArray(turns)) return;
    for (const turn of turns) {
      const t = asRecord(turn);
      const steps = t?.steps;
      if (!Array.isArray(steps)) continue;
      for (const step of steps) {
        if (step && typeof step === "object") {
          expandTaskStepIfPresent(jobId, step as ConversationStep);
        }
      }
    }
  } catch {
    /* conversation() optional / unsupported — ignore */
  }
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
        ? `${(n / 1000).toFixed(1)}k`
        : String(n);
  appendJobProgress(jobId, "usage", short(lastInput));
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
  const nest = trackRootAgent(
    jobId,
    "agent_id" in message && typeof message.agent_id === "string"
      ? message.agent_id
      : undefined,
  );
  const nestPrefix = nest ? `[sub ${nest.tag}] ` : "";
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
      if (nest) {
        // Nested thinking → kind task (SUBAGENT badge); avoid breaking coalesce with prefixes.
        appendJobProgress(jobId, "task", message.text);
      } else {
        appendJobProgress(jobId, "thinking", message.text);
      }
      break;
    case "assistant": {
      const texts = message.message.content
        .filter((b): b is { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text)
        .join("");
      if (texts) {
        appendJobProgress(jobId, nest ? "task" : "assistant", texts);
      }
      for (const b of message.message.content) {
        if (b.type === "tool_use") {
          captureCreatePlanFromTool(jobId, b.name, b.input);
          appendJobProgress(
            jobId,
            "tool",
            `${nestPrefix}${summarizeToolArgs(b.name, b.input)}`,
          );
        }
      }
      break;
    }
    case "tool_call": {
      captureCreatePlanFromTool(jobId, message.name, message.args, {
        // Prefer completed/full args; running may be empty/partial
        mirrorToProcess: message.status !== "running",
      });
      const label = summarizeToolArgs(message.name, message.args);
      const suffix =
        message.status === "running"
          ? "…"
          : message.status === "error"
            ? " ✗"
            : " ✓";
      // Parent Task spawn stays unprefixed; nested agent tools get [sub …].
      appendJobProgress(jobId, "tool", `${nestPrefix}${label}${suffix}`);
      if (
        (message.name === "task" ||
          message.name === "Task" ||
          message.name === "agent") &&
        message.status === "completed" &&
        message.result != null
      ) {
        expandTaskConversationSteps(jobId, message.call_id, message.result);
      }
      break;
    }
    case "task":
      if (message.text || message.status) {
        const body = [message.status, message.text].filter(Boolean).join(" — ");
        appendJobProgress(jobId, "task", body);
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
