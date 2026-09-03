import { Agent, CursorAgentError } from "@cursor/sdk";
import { setMaxListeners } from "node:events";
import { collectLinkedIssueContext } from "../gitlab/linked-context.js";
import { logger } from "../../logger.js";
import { publishRealtime } from "../realtime/hub.js";
import type { IssueJob } from "../../types.js";
import {
  resolveCursorApiKey,
  resolveCursorModel,
  resolveRepoPath,
} from "../../workspace/creds.js";
import {
  graphifyEnabled,
  prepareWorkGraphifyContext,
  type WorkGraphifyPrep,
} from "../../workspace/graphify.js";
import { withGraphifyCustomTools } from "../ba/graphifyTools.js";
import {
  buildAdhocFollowUpPrompt,
  buildDocsPhasePrompt,
  buildFollowUpPrompt,
  buildResumePrompt,
  buildWorkPrompt,
  parseAgentOutcome,
} from "./prompt.js";
import {
  appendJobProgress,
  appendPromptSending,
  appendSdkMessage,
  clearJobProgress,
  getJobTokenUsage,
  recordTokenUsage,
  type JobTokenSnapshot,
} from "./progress.js";

// Cursor SDK attaches many AbortSignal listeners during a run.
setMaxListeners(100);

/** Cursor HTTP/2 rate-limit / stream kill / hang / auth exchange — must not crash the Node process. */
export function isTransientCursorTransportError(err: unknown): boolean {
  if (
    err &&
    typeof err === "object" &&
    (err as { cursorTransient?: boolean }).cursorTransient === true
  ) {
    return true;
  }
  const msg =
    err instanceof Error
      ? `${err.message} ${String((err as Error & { cause?: unknown }).cause ?? "")}`
      : String(err);
  return (
    /ENHANCE_YOUR_CALM/i.test(msg) ||
    /ERR_HTTP2_STREAM_ERROR/i.test(msg) ||
    (/ConnectError/i.test(msg) && /Stream closed/i.test(msg)) ||
    /API key exchange endpoint/i.test(msg) ||
    (/ConnectError/i.test(msg) && /fetch failed/i.test(msg)) ||
    /Failed to connect to API key exchange/i.test(msg) ||
    /timed out after/i.test(msg) ||
    /waiting for first (event|message)/i.test(msg) ||
    /already has active run/i.test(msg) ||
    /Cursor API unreachable/i.test(msg) ||
    /Cursor cắt .+ run/i.test(msg) ||
    /Cursor tạm ngắt/i.test(msg)
  );
}

/** Mark an Error so queue retry treats it as a transient Cursor transport failure. */
export function markCursorTransient(err: Error): Error {
  (err as Error & { cursorTransient?: boolean }).cursorTransient = true;
  return err;
}

export type CursorRunErrorDetail = {
  id: string;
  result?: string;
  durationMs?: number;
  errorCode?: string;
  requestId?: string;
};

function isRetryableCursorResultText(text: string): boolean {
  return (
    /ENHANCE_YOUR_CALM|ERR_HTTP2|stream closed|timed out|timeout|fetch failed|API key exchange|rate.?limit|overloaded|unavailable|temporar|ECONNRESET|ETIMEDOUT|socket hang up/i.test(
      text,
    )
  );
}

/**
 * Turn Cursor SDK `status=error` into a VI-readable Error.
 * Opaque empty failures (common after long runs) are marked transient for auto-retry.
 */
export function errorFromCursorRunStatus(
  detail: CursorRunErrorDetail,
  opts?: { label?: string },
): Error {
  const label = opts?.label ?? "Agent";
  const resultText = detail.result?.trim() || "";
  const durationMs = detail.durationMs ?? 0;
  const metaBits = [
    detail.errorCode && `code=${detail.errorCode}`,
    detail.requestId && `req=${detail.requestId}`,
    durationMs > 0 && `${Math.round(durationMs / 1000)}s`,
  ].filter(Boolean) as string[];

  // Short empty → never connected
  if (!resultText && durationMs > 0 && durationMs < 15_000) {
    return markCursorTransient(
      new Error(
        formatCursorAgentFailure(
          new Error(
            "Failed to connect to API key exchange endpoint: fetch failed",
          ),
          `${label} run failed (${detail.id})`,
        ),
      ),
    );
  }

  // Empty body (often long runs ~15min) — Cursor cut stream without details
  if (!resultText) {
    const when =
      durationMs >= 60_000
        ? `~${Math.max(1, Math.round(durationMs / 60_000))} phút`
        : durationMs > 0
          ? `~${Math.round(durationMs / 1000)}s`
          : "không rõ thời gian";
    const meta = metaBits.length ? ` (${metaBits.join(" · ")})` : "";
    return markCursorTransient(
      new Error(
        `Cursor cắt ${label.toLowerCase()} run sau ${when}${meta}. ` +
          `Thường do timeout / mất stream phía Cursor — hệ thống sẽ tự thử lại nếu còn lượt; không thì Gửi/Run lại.`,
      ),
    );
  }

  const raw = `${label} run failed (${detail.id}): ${[
    ...metaBits,
    resultText.slice(0, 500),
  ].join(" · ")}`;
  const msg = formatCursorAgentFailure(new Error(resultText), raw);
  const err = new Error(msg);
  if (isRetryableCursorResultText(resultText) || isRetryableCursorResultText(msg)) {
    markCursorTransient(err);
  }
  return err;
}

/** Human-readable Cursor connectivity / auth failures */
export function formatCursorAgentFailure(err: unknown, fallback: string): string {
  const msg =
    err instanceof Error
      ? `${err.message} ${String((err as Error & { cause?: unknown }).cause ?? "")}`
      : String(err);
  if (
    /API key exchange endpoint/i.test(msg) ||
    (/ConnectError/i.test(msg) && /fetch failed/i.test(msg))
  ) {
    return (
      "Không kết nối được Cursor API (API key exchange / fetch failed). " +
      "Kiểm tra mạng, VPN, hoặc Cursor API key trong Settings → Cursor, rồi thử lại."
    );
  }
  if (/ENHANCE_YOUR_CALM|ERR_HTTP2/i.test(msg)) {
    return "Cursor giới hạn tốc độ / HTTP2 đóng — đợi vài giây rồi Gửi lại.";
  }
  if (/Cursor cắt .+ run/i.test(msg)) {
    return msg.trim();
  }
  // Opaque English "Agent run failed (run-…): req=… · Nms"
  if (
    /Agent run failed/i.test(msg) &&
    !/\bcode=/i.test(msg) &&
    !/: .{30,}/.test(msg.replace(/req=[^\s·]+/g, "").replace(/\d+ms/g, ""))
  ) {
    return (
      "Cursor cắt agent run (không có chi tiết lỗi). " +
      "Thường do timeout / mất stream — thử Gửi/Run lại."
    );
  }
  return fallback;
}

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

type CancellableRun = {
  cancel: () => Promise<void>;
};

type SdkRun = Awaited<
  ReturnType<Awaited<ReturnType<typeof Agent.create>>["send"]>
>;

/** Active Cursor runs keyed by jobId — used by Force Stop. */
const activeRunsByJob = new Map<string, CancellableRun>();

/** Kill requested even before a Run is attached (create/send phase). */
const killRequestedByJob = new Set<string>();

export function markJobKillRequested(jobId: string): void {
  killRequestedByJob.add(jobId);
}

export function clearJobKillRequested(jobId: string): void {
  killRequestedByJob.delete(jobId);
}

export function isJobKillRequested(jobId: string): boolean {
  return killRequestedByJob.has(jobId);
}

function throwIfKillRequested(jobId: string | undefined): void {
  if (jobId && killRequestedByJob.has(jobId)) {
    throw new Error("Force-stopped from UI");
  }
}

export async function cancelActiveAgentRun(jobId: string): Promise<boolean> {
  markJobKillRequested(jobId);
  const entry = activeRunsByJob.get(jobId);
  if (!entry) return false;
  try {
    await entry.cancel();
    return true;
  } catch (err) {
    logger.warn("cancelActiveAgentRun failed", {
      jobId,
      err: String(err),
    });
    return false;
  }
}

/** Track job as cancellable from create/send (Force Stop mid-chat / mid-Run). */
export function beginCancellableJob(jobId: string | undefined): {
  check: () => void;
  attach: (run: SdkRun) => void;
  end: () => void;
} {
  if (!jobId) {
    return { check: () => undefined, attach: () => undefined, end: () => undefined };
  }
  let attached: SdkRun | null = null;
  activeRunsByJob.set(jobId, {
    cancel: async () => {
      markJobKillRequested(jobId);
      if (!attached || typeof attached.cancel !== "function") return;
      const supports =
        typeof (attached as { supports?: (f: string) => boolean }).supports ===
        "function"
          ? (attached as { supports: (f: string) => boolean }).supports("cancel")
          : true;
      if (supports) await attached.cancel();
    },
  });
  return {
    check: () => throwIfKillRequested(jobId),
    attach: (run) => {
      attached = run;
      trackRun(jobId, run);
    },
    end: () => untrackRun(jobId),
  };
}

async function collectAssistantText(
  run: SdkRun,
  jobId?: string,
  opts?: { promptChars?: number; firstEventTimeoutMs?: number },
): Promise<{ text: string; usage: JobTokenSnapshot | null }> {
  if (jobId) {
    clearJobProgress(jobId);
    appendJobProgress(jobId, "status", "Cursor agent started — chờ phản hồi…");
  }

  const firstEventMs = opts?.firstEventTimeoutMs ?? 75_000;
  let streamed = "";
  let lastTurnInput = 0;
  try {
    if (typeof run.stream === "function" && run.supports?.("stream") !== false) {
      const it = run.stream()[Symbol.asyncIterator]();
      let firstTimer: ReturnType<typeof setTimeout> | undefined;
      const first = await Promise.race([
        it.next(),
        new Promise<IteratorResult<unknown>>((_, reject) => {
          firstTimer = setTimeout(() => {
            void run.cancel?.().catch(() => undefined);
            reject(
              new Error(
                `Cursor timed out after ${Math.round(firstEventMs / 1000)}s waiting for first event`,
              ),
            );
          }, firstEventMs);
        }),
      ]);
      if (firstTimer) clearTimeout(firstTimer);
      if (jobId) {
        appendJobProgress(jobId, "status", "Cursor đang stream…");
      }

      let step = first as IteratorResult<{
        type?: string;
        message?: { content?: Array<{ type?: string; text?: string }> };
        usage?: { inputTokens?: number };
      }>;
      while (!step.done) {
        const message = step.value as Parameters<typeof appendSdkMessage>[1];
        appendSdkMessage(jobId, message);
        if (message && message.type === "assistant") {
          const content =
            (
              message as {
                message?: { content?: Array<{ type?: string; text?: string }> };
              }
            ).message?.content ?? [];
          for (const block of content) {
            if (block.type === "text" && block.text) streamed += block.text;
          }
        }
        const raw = message as {
          type?: string;
          usage?: { inputTokens?: number };
        };
        if (raw?.type === "usage" && raw.usage?.inputTokens) {
          lastTurnInput = raw.usage.inputTokens;
        }
        step = (await it.next()) as typeof step;
      }
    }
  } catch (err) {
    appendJobProgress(jobId, "status", `stream error: ${String(err)}`);
    logger.warn("Agent stream failed; falling back to wait()", {
      err: String(err),
    });
    if (isTransientCursorTransportError(err)) {
      throw err instanceof Error
        ? err
        : new Error(
            "Cursor stream closed (NGHTTP2_ENHANCE_YOUR_CALM) — rate limit / connection. Thử Gửi lại.",
          );
    }
  }

  let result: Awaited<ReturnType<SdkRun["wait"]>>;
  try {
    result = await run.wait();
  } catch (err) {
    appendJobProgress(jobId, "status", `wait error: ${String(err)}`);
    if (isTransientCursorTransportError(err)) {
      throw err instanceof Error
        ? err
        : new Error(
            "Cursor stream closed (NGHTTP2_ENHANCE_YOUR_CALM) — rate limit / connection. Thử Gửi lại.",
          );
    }
    throw err instanceof Error ? err : new Error(String(err));
  }
  if (result.status === "cancelled") {
    appendJobProgress(jobId, "status", "cancelled");
    throw new Error("Agent run cancelled (force stop)");
  }
  if (result.status === "error") {
    const detail = result as CursorRunErrorDetail;
    const err = errorFromCursorRunStatus(detail, { label: "Agent" });
    appendJobProgress(jobId, "status", err.message);
    logger.error("Cursor run status=error", {
      runId: detail.id,
      errorCode: detail.errorCode,
      requestId: detail.requestId,
      durationMs: detail.durationMs,
      resultPreview: detail.result?.slice(0, 800),
      transient: isTransientCursorTransportError(err),
    });
    throw err;
  }
  const text = (result.result ?? streamed).trim();
  if (text) {
    process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
  }

  const usageFromResult = (
    result as { usage?: Parameters<typeof recordTokenUsage>[1] }
  ).usage;
  const liveUsage = (run as { usage?: Parameters<typeof recordTokenUsage>[1] })
    .usage;
  const sdkUsage = usageFromResult ?? liveUsage;
  const hasSdk =
    Boolean(sdkUsage) &&
    (Number(sdkUsage?.inputTokens) > 0 ||
      Number(sdkUsage?.totalTokens) > 0 ||
      Number(sdkUsage?.outputTokens) > 0);
  // Fallback: ~chars/4 — SDK local often omits usage; still show % in UI
  const inEst = Math.max(1, Math.ceil((opts?.promptChars ?? 0) / 4));
  const outEst = Math.max(0, Math.ceil((streamed || text).length / 4));
  const fallback = {
    inputTokens: inEst,
    outputTokens: outEst,
    totalTokens: inEst + outEst,
  };
  const usage =
    (jobId &&
      recordTokenUsage(jobId, hasSdk ? sdkUsage : fallback, {
        lastTurnInput: lastTurnInput || (hasSdk ? undefined : inEst),
      })) ||
    (jobId ? getJobTokenUsage(jobId) : null);

  if (jobId && usage) {
    logger.info("Token usage recorded", {
      jobId,
      contextPct: usage.contextPct,
      lastInputTokens: usage.lastInputTokens,
      contextWindow: usage.contextWindow,
      fromSdk: hasSdk,
    });
  }

  appendJobProgress(jobId, "status", "Cursor agent finished");
  return { text, usage };
}

function trackRun(jobId: string | undefined, run: SdkRun): void {
  if (!jobId) return;
  activeRunsByJob.set(jobId, {
    cancel: async () => {
      const supports =
        typeof (run as { supports?: (f: string) => boolean }).supports ===
        "function"
          ? (run as { supports: (f: string) => boolean }).supports("cancel")
          : true;
      if (supports && typeof run.cancel === "function") {
        await run.cancel();
      }
    },
  });
}

function untrackRun(jobId: string | undefined): void {
  if (!jobId) return;
  activeRunsByJob.delete(jobId);
  publishRealtime({
    type: "progress",
    jobId,
    line: {
      id: 0,
      at: new Date().toISOString(),
      kind: "status",
      text: "Cursor agent idle",
    },
    live: false,
  });
}

/** Used by Q&A / merge-resolve so Force Stop can cancel. */
export function trackExternalRun(jobId: string, run: SdkRun): void {
  trackRun(jobId, run);
}

export function untrackExternalRun(jobId: string): void {
  untrackRun(jobId);
}

export function hasActiveAgentRun(jobId: string): boolean {
  return activeRunsByJob.has(jobId);
}

export type AgentRunResult = {
  agentId: string;
  kind: "done" | "docs_ready" | "need_clarification" | "unknown";
  text: string;
  question?: string;
  summary?: string;
  usage?: JobTokenSnapshot | null;
  resumed?: boolean;
};

type RunOpts = {
  jobId?: string;
  devNotes?: string;
  phase?: "docs" | "code";
  approvedDocsPaths?: string[];
  chatContext?: string;
  /** Resume this agent window (1 task = 1 agent). */
  existingAgentId?: string;
  /** Injected CONTEXT QUALITY block (good / searchable). */
  contextQualityBlock?: string;
  /** Truncated Google Sheets values from task links. */
  googleSheetsBlock?: string;
  /** Figma structure/text from opted-in links. */
  figmaBlock?: string;
  /** Remaining NEED_CLARIFICATION rounds before the job hard-fails. */
  clarifyRoundsLeft?: number;
  /** WorkBench graphify map injected into the prompt. */
  graphifyBlock?: string;
};

export function workAgentLocal() {
  const local = withGraphifyCustomTools(resolveRepoPath());
  return {
    cwd: local.cwd,
    ...(local.customTools
      ? { customTools: local.customTools as never }
      : {}),
  };
}

function graphifyQuestionForIssue(issue: IssueJob, extra?: string): string {
  return [
    issue.title,
    (issue.description || "").replace(/\s+/g, " ").slice(0, 400),
    extra?.trim().slice(0, 200),
  ]
    .filter(Boolean)
    .join(" | ");
}

function appendGraphifyPrepStatus(
  jobId: string | undefined,
  status: WorkGraphifyPrep["status"],
) {
  if (!jobId) return;
  if (status === "disabled") {
    appendJobProgress(jobId, "status", "Code map skipped (graphify disabled)");
  } else if (status === "ready") {
    appendJobProgress(jobId, "status", "Code map ready (graphify)");
  } else {
    appendJobProgress(
      jobId,
      "status",
      "Code map unavailable (graphify missing or empty graph)",
    );
  }
}

export async function loadWorkGraphifyBlock(
  issue: IssueJob,
  jobId: string | undefined,
  extra?: string,
): Promise<string> {
  if (!graphifyEnabled()) {
    appendGraphifyPrepStatus(jobId, "disabled");
    return "";
  }
  if (jobId) {
    appendJobProgress(jobId, "status", "Preparing code map (graphify)…");
  }
  const prep = await prepareWorkGraphifyContext({
    sourcePath: resolveRepoPath(),
    question: graphifyQuestionForIssue(issue, extra),
  });
  appendGraphifyPrepStatus(jobId, prep.status);
  return prep.block;
}

async function buildMissionPrompt(
  issue: IssueJob,
  extraContext: string | undefined,
  opts: RunOpts,
  resumed: boolean,
): Promise<string> {
  let linkedBlock = "";
  try {
    const linked = await collectLinkedIssueContext(issue);
    linkedBlock = linked.promptBlock;
  } catch (err) {
    logger.warn("Linked context load failed", { err: String(err) });
  }
  const notes = opts.devNotes?.trim() || undefined;
  const graphifyBlock = opts.graphifyBlock;
  const body =
    opts.phase === "docs"
      ? buildDocsPhasePrompt(issue, linkedBlock, notes, {
          chatContext: opts.chatContext,
          contextQualityBlock: opts.contextQualityBlock,
          googleSheetsBlock: opts.googleSheetsBlock,
          figmaBlock: opts.figmaBlock,
          graphifyBlock,
        })
      : buildWorkPrompt(issue, extraContext, linkedBlock, notes, {
          approvedDocsPaths: opts.approvedDocsPaths,
          chatContext: opts.chatContext,
          contextQualityBlock: opts.contextQualityBlock,
          googleSheetsBlock: opts.googleSheetsBlock,
          figmaBlock: opts.figmaBlock,
          clarifyRoundsLeft: opts.clarifyRoundsLeft,
          graphifyBlock,
        });
  if (!resumed) return body;
  return `You are CONTINUING the **same agent window** for GitLab issue #${issue.issueIid}.
Keep prior conversation / tool context. This is a new Run turn — execute the updated instructions end-to-end (not Q&A-only).

${body}`;
}

/**
 * One job ↔ one Cursor agent window: resume `existingAgentId` when set,
 * otherwise create. Switching jobs uses that job's agentId.
 */
export async function runNewAgent(
  issue: IssueJob,
  extraContext?: string,
  opts?: RunOpts,
): Promise<AgentRunResult> {
  const modelId = resolveCursorModel();
  const existing = opts?.existingAgentId?.trim();
  let resumed = false;
  let agent: Awaited<ReturnType<typeof Agent.create>>;
  const session = beginCancellableJob(opts?.jobId);

  try {
    session.check();
    const graphifyBlock = await loadWorkGraphifyBlock(
      issue,
      opts?.jobId,
      extraContext,
    );
    session.check();
    if (existing) {
      try {
        agent = await Agent.resume(existing, {
          apiKey: resolveCursorApiKey(),
          model: { id: modelId },
          local: workAgentLocal(),
        });
        resumed = true;
        logger.info("Resumed agent window for job", {
          agentId: agent.agentId,
          model: modelId,
          phase: opts?.phase ?? "code",
        });
      } catch (err) {
        logger.warn("Resume failed — creating new agent window", {
          existing,
          err: String(err),
        });
        session.check();
        agent = await Agent.create({
          apiKey: resolveCursorApiKey(),
          model: { id: modelId },
          local: workAgentLocal(),
        });
      }
    } else {
      agent = await Agent.create({
        apiKey: resolveCursorApiKey(),
        model: { id: modelId },
        local: workAgentLocal(),
      });
      logger.info("Created local agent window", {
        agentId: agent.agentId,
        model: modelId,
        phase: opts?.phase ?? "code",
        hasChatContext: Boolean(opts?.chatContext?.trim()),
      });
    }

    session.check();
    await using disposed = agent;
    const prompt = await buildMissionPrompt(
      issue,
      extraContext,
      { ...(opts ?? {}), graphifyBlock },
      resumed,
    );
    session.check();
    if (opts?.jobId) {
      appendJobProgress(
        opts.jobId,
        "status",
        resumed
          ? `Resumed agent window ${disposed.agentId}`
          : `New agent window ${disposed.agentId}`,
      );
      appendPromptSending(opts.jobId, prompt);
    }
    const run = await disposed.send(prompt);
    logger.info("Agent run started", {
      runId: run.id,
      agentId: disposed.agentId,
      resumed,
    });
    session.attach(run);
    const { text, usage } = await collectAssistantText(run, opts?.jobId, {
      promptChars: prompt.length,
    });
    session.check();
    const parsed = parseAgentOutcome(text);
    return {
      agentId: disposed.agentId,
      kind: parsed.kind,
      text,
      question: parsed.question,
      summary: parsed.summary,
      usage,
      resumed,
    };
  } finally {
    session.end();
  }
}

export async function resumeAgent(
  agentId: string,
  answer: string,
  issue: IssueJob,
  opts?: { jobId?: string; clarifyRoundsLeft?: number },
): Promise<AgentRunResult> {
  const modelId = resolveCursorModel();
  await using agent = await Agent.resume(agentId, {
    apiKey: resolveCursorApiKey(),
    model: { id: modelId },
    local: workAgentLocal(),
  });

  logger.info("Resumed agent (clarify)", {
    agentId: agent.agentId,
    model: modelId,
  });
  const graphifyBlock = await loadWorkGraphifyBlock(issue, opts?.jobId, answer);
  const prompt = `${graphifyBlock ? `${graphifyBlock}\n\n` : ""}${buildResumePrompt(answer, issue, {
    clarifyRoundsLeft: opts?.clarifyRoundsLeft,
  })}`;
  if (opts?.jobId) {
    appendPromptSending(opts.jobId, prompt);
  }
  const run = await agent.send(prompt);
  logger.info("Resume run started", { runId: run.id, agentId: agent.agentId });
  trackRun(opts?.jobId, run);
  try {
    const { text, usage } = await collectAssistantText(run, opts?.jobId, {
      promptChars: prompt.length,
    });
    const parsed = parseAgentOutcome(text);
    return {
      agentId: agent.agentId,
      kind: parsed.kind,
      text,
      question: parsed.question,
      summary: parsed.summary,
      usage,
      resumed: true,
    };
  } finally {
    untrackRun(opts?.jobId);
  }
}

/**
 * IDE-style follow-up chat for a job.
 * Always opens a **fresh** agent window — resume often fails with
 * "already has active run" after crash/hang/force-stop. Prior chat is
 * injected into the prompt instead.
 */
export async function continueAgentWindow(
  issue: IssueJob,
  message: string,
  opts?: {
    jobId?: string;
    chatHistory?: string;
    contextQualityBlock?: string;
    googleSheetsBlock?: string;
    figmaBlock?: string;
  },
): Promise<AgentRunResult> {
  const modelId = resolveCursorModel();
  const isAdhoc = issue.issueIid <= 0 || issue.action === "adhoc";

  if (opts?.jobId) {
    clearJobProgress(opts.jobId);
    appendJobProgress(opts.jobId, "status", "Opening a new agent window…");
  }

  const graphifyBlock = await loadWorkGraphifyBlock(
    issue,
    opts?.jobId,
    message,
  );
  const prompt = isAdhoc
    ? buildAdhocFollowUpPrompt(message, issue.title, {
        chatHistory: opts?.chatHistory,
        contextQualityBlock: opts?.contextQualityBlock,
        googleSheetsBlock: opts?.googleSheetsBlock,
        figmaBlock: opts?.figmaBlock,
        graphifyBlock,
      })
    : buildFollowUpPrompt(message, issue, {
        chatHistory: opts?.chatHistory,
        contextQualityBlock: opts?.contextQualityBlock,
        googleSheetsBlock: opts?.googleSheetsBlock,
        figmaBlock: opts?.figmaBlock,
        graphifyBlock,
      });

  const session = beginCancellableJob(opts?.jobId);
  try {
    session.check();
    const agent = await Agent.create({
      apiKey: resolveCursorApiKey(),
      model: { id: modelId },
      local: workAgentLocal(),
    }).catch((err) => {
      throw new Error(
        formatCursorAgentFailure(
          err,
          err instanceof Error ? err.message : String(err),
        ),
      );
    });
    session.check();
    logger.info("Follow-up new agent window", {
      agentId: agent.agentId,
      model: modelId,
    });

    await using disposed = agent;
    if (opts?.jobId) {
      appendJobProgress(
        opts.jobId,
        "status",
        `Cửa sổ ${disposed.agentId.slice(0, 18)}…`,
      );
      appendPromptSending(opts.jobId, prompt);
    }

    session.check();
    let run: SdkRun;
    try {
      run = await withTimeout(disposed.send(prompt), 60_000, "agent.send");
    } catch (err) {
      session.check();
      const msg = formatCursorAgentFailure(
        err,
        err instanceof Error ? err.message : String(err),
      );
      if (opts?.jobId) {
        appendJobProgress(opts.jobId, "status", `Gửi prompt lỗi: ${msg}`);
      }
      throw new Error(msg);
    }

    session.check();
    session.attach(run);
    const { text, usage } = await collectAssistantText(run, opts?.jobId, {
      promptChars: prompt.length,
      // Fail faster on Cursor network hangs so UI can Force Stop / retry
      firstEventTimeoutMs: 45_000,
    });
    session.check();
    const parsed = parseAgentOutcome(text);
    return {
      agentId: disposed.agentId,
      kind: parsed.kind,
      text,
      question: parsed.question,
      summary: parsed.summary,
      usage,
      resumed: false,
    };
  } finally {
    session.end();
  }
}

export function isStartupError(err: unknown): err is CursorAgentError {
  return err instanceof CursorAgentError;
}
