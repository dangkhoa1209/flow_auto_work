import { Agent, CursorAgentError } from "@cursor/sdk";
import { setMaxListeners } from "node:events";
import { collectLinkedIssueContext } from "../gitlab/linked-context.js";
import { logger } from "../logger.js";
import type { IssueJob } from "../types.js";
import {
  resolveCursorApiKey,
  resolveCursorModel,
  resolveRepoPath,
} from "../workspace/creds.js";
import {
  buildDocsPhasePrompt,
  buildFollowUpPrompt,
  buildResumePrompt,
  buildWorkPrompt,
  parseAgentOutcome,
} from "./prompt.js";
import {
  appendJobProgress,
  appendSdkMessage,
  clearJobProgress,
  getJobTokenUsage,
  recordTokenUsage,
  type JobTokenSnapshot,
} from "./progress.js";

// Cursor SDK attaches many AbortSignal listeners during a run.
setMaxListeners(50);

type CancellableRun = {
  cancel: () => Promise<void>;
};

type SdkRun = Awaited<
  ReturnType<Awaited<ReturnType<typeof Agent.create>>["send"]>
>;

/** Active Cursor runs keyed by jobId — used by Force Stop. */
const activeRunsByJob = new Map<string, CancellableRun>();

export async function cancelActiveAgentRun(jobId: string): Promise<boolean> {
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

async function collectAssistantText(
  run: SdkRun,
  jobId?: string,
): Promise<{ text: string; usage: JobTokenSnapshot | null }> {
  if (jobId) {
    clearJobProgress(jobId);
    appendJobProgress(jobId, "status", "Cursor agent started");
  }

  let streamed = "";
  let lastTurnInput = 0;
  try {
    if (typeof run.stream === "function" && run.supports?.("stream") !== false) {
      for await (const message of run.stream()) {
        appendSdkMessage(jobId, message);
        if (message.type === "assistant") {
          for (const block of message.message.content) {
            if (block.type === "text") streamed += block.text;
          }
        }
        const raw = message as { type?: string; usage?: { inputTokens?: number } };
        if (raw.type === "usage" && raw.usage?.inputTokens) {
          lastTurnInput = raw.usage.inputTokens;
        }
      }
    }
  } catch (err) {
    appendJobProgress(jobId, "status", `stream error: ${String(err)}`);
    logger.warn("Agent stream failed; falling back to wait()", {
      err: String(err),
    });
  }

  const result = await run.wait();
  if (result.status === "cancelled") {
    appendJobProgress(jobId, "status", "cancelled");
    throw new Error("Agent run cancelled (force stop)");
  }
  if (result.status === "error") {
    const detail = result as {
      id: string;
      result?: string;
      durationMs?: number;
      errorCode?: string;
      requestId?: string;
    };
    const bits = [
      detail.errorCode && `code=${detail.errorCode}`,
      detail.requestId && `req=${detail.requestId}`,
      detail.durationMs != null && `${detail.durationMs}ms`,
      detail.result?.trim()?.slice(0, 500),
    ].filter(Boolean);
    const msg = bits.length
      ? `Agent run failed (${detail.id}): ${bits.join(" · ")}`
      : `Agent run failed: ${detail.id}`;
    appendJobProgress(jobId, "status", msg);
    logger.error("Cursor run status=error", {
      runId: detail.id,
      errorCode: detail.errorCode,
      requestId: detail.requestId,
      durationMs: detail.durationMs,
      resultPreview: detail.result?.slice(0, 800),
    });
    throw new Error(msg);
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
  const usage =
    (jobId &&
      recordTokenUsage(jobId, usageFromResult ?? liveUsage, {
        lastTurnInput: lastTurnInput || undefined,
      })) ||
    (jobId ? getJobTokenUsage(jobId) : null);

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
  if (jobId) activeRunsByJob.delete(jobId);
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
  techLeadNotes?: string;
  devNotes?: string;
  phase?: "docs" | "code";
  approvedDocsPaths?: string[];
  chatContext?: string;
  /** Resume this agent window (1 task = 1 agent). */
  existingAgentId?: string;
};

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
  const notes = opts.devNotes?.trim() || opts.techLeadNotes?.trim() || undefined;
  const body =
    opts.phase === "docs"
      ? buildDocsPhasePrompt(issue, linkedBlock, notes, {
          chatContext: opts.chatContext,
        })
      : buildWorkPrompt(issue, extraContext, linkedBlock, notes, {
          approvedDocsPaths: opts.approvedDocsPaths,
          chatContext: opts.chatContext,
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

  if (existing) {
    try {
      agent = await Agent.resume(existing, {
        apiKey: resolveCursorApiKey(),
        model: { id: modelId },
        local: { cwd: resolveRepoPath() },
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
      agent = await Agent.create({
        apiKey: resolveCursorApiKey(),
        model: { id: modelId },
        local: { cwd: resolveRepoPath() },
      });
    }
  } else {
    agent = await Agent.create({
      apiKey: resolveCursorApiKey(),
      model: { id: modelId },
      local: { cwd: resolveRepoPath() },
    });
    logger.info("Created local agent window", {
      agentId: agent.agentId,
      model: modelId,
      phase: opts?.phase ?? "code",
      hasChatContext: Boolean(opts?.chatContext?.trim()),
    });
  }

  await using disposed = agent;
  const prompt = await buildMissionPrompt(
    issue,
    extraContext,
    opts ?? {},
    resumed,
  );
  const run = await disposed.send(prompt);
  logger.info("Agent run started", {
    runId: run.id,
    agentId: disposed.agentId,
    resumed,
  });
  if (opts?.jobId) {
    appendJobProgress(
      opts.jobId,
      "status",
      resumed
        ? `Resumed agent window ${disposed.agentId}`
        : `New agent window ${disposed.agentId}`,
    );
  }
  trackRun(opts?.jobId, run);
  try {
    const { text, usage } = await collectAssistantText(run, opts?.jobId);
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
    untrackRun(opts?.jobId);
  }
}

export async function resumeAgent(
  agentId: string,
  answer: string,
  issue: IssueJob,
  opts?: { jobId?: string },
): Promise<AgentRunResult> {
  const modelId = resolveCursorModel();
  await using agent = await Agent.resume(agentId, {
    apiKey: resolveCursorApiKey(),
    model: { id: modelId },
    local: { cwd: resolveRepoPath() },
  });

  logger.info("Resumed agent (clarify)", {
    agentId: agent.agentId,
    model: modelId,
  });
  const run = await agent.send(buildResumePrompt(answer, issue));
  logger.info("Resume run started", { runId: run.id, agentId: agent.agentId });
  trackRun(opts?.jobId, run);
  try {
    const { text, usage } = await collectAssistantText(run, opts?.jobId);
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
 * Cursor-IDE-style follow-up on the same job agent window.
 * Creates a window if none exists yet.
 */
export async function continueAgentWindow(
  issue: IssueJob,
  message: string,
  opts?: { jobId?: string; existingAgentId?: string },
): Promise<AgentRunResult> {
  const modelId = resolveCursorModel();
  const existing = opts?.existingAgentId?.trim();
  let resumed = false;
  let agent: Awaited<ReturnType<typeof Agent.create>>;

  if (existing) {
    try {
      agent = await Agent.resume(existing, {
        apiKey: resolveCursorApiKey(),
        model: { id: modelId },
        local: { cwd: resolveRepoPath() },
      });
      resumed = true;
      logger.info("Follow-up on existing agent window", {
        agentId: agent.agentId,
        model: modelId,
      });
    } catch (err) {
      logger.warn("Follow-up resume failed — new window", {
        existing,
        err: String(err),
      });
      agent = await Agent.create({
        apiKey: resolveCursorApiKey(),
        model: { id: modelId },
        local: { cwd: resolveRepoPath() },
      });
    }
  } else {
    agent = await Agent.create({
      apiKey: resolveCursorApiKey(),
      model: { id: modelId },
      local: { cwd: resolveRepoPath() },
    });
    logger.info("Follow-up created new agent window", {
      agentId: agent.agentId,
      model: modelId,
    });
  }

  await using disposed = agent;
  const prompt = buildFollowUpPrompt(message, issue);
  if (opts?.jobId) {
    appendJobProgress(
      opts.jobId,
      "status",
      resumed
        ? `IDE follow-up · window ${disposed.agentId}`
        : `IDE chat · new window ${disposed.agentId}`,
    );
  }
  const run = await disposed.send(prompt);
  trackRun(opts?.jobId, run);
  try {
    const { text, usage } = await collectAssistantText(run, opts?.jobId);
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
    untrackRun(opts?.jobId);
  }
}

export function isStartupError(err: unknown): err is CursorAgentError {
  return err instanceof CursorAgentError;
}
