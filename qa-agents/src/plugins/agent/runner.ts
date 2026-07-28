import { Agent, CursorAgentError } from "@cursor/sdk";
import { logger } from "../../../../src/logger.js";
import {
  resolveCursorApiKey,
  resolveCursorModel,
  resolveRepoPath,
} from "../../../../src/workspace/creds.js";
import { appendQaProgress } from "../../job-store.js";
import type { QaAgentOutcome } from "../../types.js";
import { chromeDevtoolsMcpServers, parseQaOutcome } from "./prompt.js";

type CancelEntry = { cancel: () => void };

const activeRuns = new Map<string, CancelEntry>();

export function cancelQaAgentRun(jobId: string): boolean {
  const entry = activeRuns.get(jobId);
  if (!entry) return false;
  try {
    entry.cancel();
  } catch {
    /* ignore */
  }
  activeRuns.delete(jobId);
  return true;
}

function collectText(messages: unknown[]): string {
  const chunks: string[] = [];
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const m = msg as Record<string, unknown>;
    if (typeof m.text === "string") chunks.push(m.text);
    if (typeof m.content === "string") chunks.push(m.content);
    if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (typeof part === "string") chunks.push(part);
        else if (
          part &&
          typeof part === "object" &&
          typeof (part as { text?: string }).text === "string"
        ) {
          chunks.push((part as { text: string }).text);
        }
      }
    }
    if (typeof m.message === "string") chunks.push(m.message);
    if (typeof m.result === "string") chunks.push(m.result);
  }
  return chunks.join("\n");
}

export async function runQaAgent(opts: {
  jobId: string;
  prompt: string;
  agentId?: string;
}): Promise<{ outcome: QaAgentOutcome; agentId?: string; text: string }> {
  const apiKey = resolveCursorApiKey();
  const modelId = resolveCursorModel();
  const mcpServers = chromeDevtoolsMcpServers();
  let cwd: string;
  try {
    cwd = resolveRepoPath();
  } catch {
    cwd = process.cwd();
  }

  appendQaProgress(
    opts.jobId,
    "agent",
    `Starting Cursor agent (model=${modelId})`,
  );

  let agent: Awaited<ReturnType<typeof Agent.create>>;
  if (opts.agentId) {
    try {
      agent = await Agent.resume(opts.agentId, {
        apiKey,
        model: { id: modelId },
        local: { cwd },
        mcpServers,
      });
    } catch (err) {
      logger.warn("QA resume failed — creating new agent", {
        err: String(err),
      });
      agent = await Agent.create({
        apiKey,
        model: { id: modelId },
        local: { cwd },
        mcpServers,
      });
    }
  } else {
    agent = await Agent.create({
      apiKey,
      model: { id: modelId },
      local: { cwd },
      mcpServers,
    });
  }

  await using disposed = agent;
  const agentId = disposed.agentId;

  const run = await disposed.send(opts.prompt, { mcpServers });
  let cancelled = false;
  activeRuns.set(opts.jobId, {
    cancel: () => {
      cancelled = true;
      void run.cancel?.();
    },
  });

  const streamed: unknown[] = [];
  try {
    for await (const event of run.stream()) {
      if (cancelled) break;
      streamed.push(event);
      const kind =
        event && typeof event === "object" && "type" in event
          ? String((event as { type: unknown }).type)
          : "event";
      const preview = JSON.stringify(event).slice(0, 400);
      if (
        kind.includes("tool") ||
        kind.includes("assistant") ||
        kind.includes("thinking") ||
        kind.includes("message")
      ) {
        appendQaProgress(opts.jobId, kind, preview);
      }
    }
    const result = await run.wait();
    if (result && typeof result === "object") {
      streamed.push(result);
      if (
        "result" in result &&
        typeof (result as { result?: unknown }).result === "string"
      ) {
        streamed.push({ text: (result as { result: string }).result });
      }
    }
  } catch (err) {
    activeRuns.delete(opts.jobId);
    if (err instanceof CursorAgentError) {
      logger.error("QA Cursor agent error", {
        err: err.message,
        jobId: opts.jobId,
      });
    }
    throw err;
  } finally {
    activeRuns.delete(opts.jobId);
  }

  const text = collectText(streamed);
  const outcome = parseQaOutcome(text);
  appendQaProgress(opts.jobId, "outcome", `Parsed outcome: ${outcome.kind}`);
  return { outcome, agentId, text };
}
