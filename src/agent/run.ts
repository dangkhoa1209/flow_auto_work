import { Agent, CursorAgentError } from "@cursor/sdk";
import { setMaxListeners } from "node:events";
import { collectLinkedIssueContext } from "../gitlab/linked-context.js";
import { logger } from "../logger.js";
import type { IssueJob } from "../types.js";
import { resolveCursorApiKey, resolveCursorModel, resolveRepoPath } from "../workspace/creds.js";
import {
  buildDocsPhasePrompt,
  buildResumePrompt,
  buildWorkPrompt,
  parseAgentOutcome,
} from "./prompt.js";
import {
  appendJobProgress,
  appendSdkMessage,
  clearJobProgress,
} from "./progress.js";

// Cursor SDK attaches many AbortSignal listeners during a run.
setMaxListeners(50);

type CancellableRun = {
  cancel: () => Promise<void>;
};

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
  run: Awaited<ReturnType<Awaited<ReturnType<typeof Agent.create>>["send"]>>,
  jobId?: string,
): Promise<string> {
  if (jobId) {
    clearJobProgress(jobId);
    appendJobProgress(jobId, "status", "Cursor agent started");
  }

  let streamed = "";
  try {
    if (typeof run.stream === "function" && run.supports?.("stream") !== false) {
      for await (const message of run.stream()) {
        appendSdkMessage(jobId, message);
        if (message.type === "assistant") {
          for (const block of message.message.content) {
            if (block.type === "text") streamed += block.text;
          }
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
  appendJobProgress(jobId, "status", "Cursor agent finished");
  return text;
}

function trackRun(
  jobId: string | undefined,
  run: Awaited<ReturnType<Awaited<ReturnType<typeof Agent.create>>["send"]>>,
): void {
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
export function trackExternalRun(
  jobId: string,
  run: Awaited<ReturnType<Awaited<ReturnType<typeof Agent.create>>["send"]>>,
): void {
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
};

export async function runNewAgent(
  issue: IssueJob,
  extraContext?: string,
  opts?: {
    jobId?: string;
    techLeadNotes?: string;
    devNotes?: string;
    /** docs = Phase A (feature docs only); code = Phase B (default) */
    phase?: "docs" | "code";
    approvedDocsPaths?: string[];
  },
): Promise<AgentRunResult> {
  let linkedBlock = "";
  try {
    const linked = await collectLinkedIssueContext(issue);
    linkedBlock = linked.promptBlock;
  } catch (err) {
    logger.warn("Linked context load failed", { err: String(err) });
  }

  const modelId = resolveCursorModel();
  await using agent = await Agent.create({
    apiKey: resolveCursorApiKey(),
    model: { id: modelId },
    local: { cwd: resolveRepoPath() },
  });

  logger.info("Created local agent", {
    agentId: agent.agentId,
    model: modelId,
    phase: opts?.phase ?? "code",
  });
  const notes = opts?.devNotes?.trim() || opts?.techLeadNotes?.trim() || undefined;
  const prompt =
    opts?.phase === "docs"
      ? buildDocsPhasePrompt(issue, linkedBlock, notes)
      : buildWorkPrompt(issue, extraContext, linkedBlock, notes, {
          approvedDocsPaths: opts?.approvedDocsPaths,
        });
  const run = await agent.send(prompt);
  logger.info("Agent run started", { runId: run.id, agentId: agent.agentId });
  trackRun(opts?.jobId, run);
  try {
    const text = await collectAssistantText(run, opts?.jobId);
    const parsed = parseAgentOutcome(text);
    return {
      agentId: agent.agentId,
      kind: parsed.kind,
      text,
      question: parsed.question,
      summary: parsed.summary,
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

  logger.info("Resumed agent", { agentId: agent.agentId, model: modelId });
  const run = await agent.send(buildResumePrompt(answer, issue));
  logger.info("Resume run started", { runId: run.id, agentId: agent.agentId });
  trackRun(opts?.jobId, run);
  try {
    const text = await collectAssistantText(run, opts?.jobId);
    const parsed = parseAgentOutcome(text);
    return {
      agentId: agent.agentId,
      kind: parsed.kind,
      text,
      question: parsed.question,
      summary: parsed.summary,
    };
  } finally {
    untrackRun(opts?.jobId);
  }
}

export function isStartupError(err: unknown): err is CursorAgentError {
  return err instanceof CursorAgentError;
}
