import { Agent, CursorAgentError } from "@cursor/sdk";
import { setMaxListeners } from "node:events";
import { getConfig } from "../config.js";
import { logger } from "../logger.js";
import type { IssueJob } from "../types.js";
import {
  buildResumePrompt,
  buildWorkPrompt,
  parseAgentOutcome,
} from "./prompt.js";

// Cursor SDK attaches many AbortSignal listeners during a run.
setMaxListeners(50);

async function collectAssistantText(
  run: Awaited<ReturnType<Awaited<ReturnType<typeof Agent.create>>["send"]>>,
): Promise<string> {
  // Prefer wait() only — streaming adds many abort listeners and triggers
  // MaxListenersExceededWarning under Node's default limit of 10.
  const result = await run.wait();
  if (result.status === "error") {
    throw new Error(`Agent run failed: ${result.id}`);
  }
  const text = (result.result ?? "").trim();
  if (text) {
    process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
  }
  return text;
}

export type AgentRunResult = {
  agentId: string;
  kind: "done" | "need_clarification" | "unknown";
  text: string;
  question?: string;
  summary?: string;
};

export async function runNewAgent(
  issue: IssueJob,
  extraContext?: string,
): Promise<AgentRunResult> {
  const config = getConfig();
  await using agent = await Agent.create({
    apiKey: config.CURSOR_API_KEY,
    model: { id: config.CURSOR_MODEL },
    local: { cwd: config.AIHR_REPO_PATH },
  });

  logger.info("Created local agent", { agentId: agent.agentId });
  const prompt = buildWorkPrompt(issue, extraContext);
  const run = await agent.send(prompt);
  logger.info("Agent run started", { runId: run.id, agentId: agent.agentId });
  const text = await collectAssistantText(run);
  const parsed = parseAgentOutcome(text);
  return {
    agentId: agent.agentId,
    kind: parsed.kind,
    text,
    question: parsed.question,
    summary: parsed.summary,
  };
}

export async function resumeAgent(
  agentId: string,
  answer: string,
  issue: IssueJob,
): Promise<AgentRunResult> {
  const config = getConfig();
  await using agent = await Agent.resume(agentId, {
    apiKey: config.CURSOR_API_KEY,
    model: { id: config.CURSOR_MODEL },
    local: { cwd: config.AIHR_REPO_PATH },
  });

  logger.info("Resumed agent", { agentId: agent.agentId });
  const run = await agent.send(buildResumePrompt(answer, issue));
  logger.info("Resume run started", { runId: run.id, agentId: agent.agentId });
  const text = await collectAssistantText(run);
  const parsed = parseAgentOutcome(text);
  return {
    agentId: agent.agentId,
    kind: parsed.kind,
    text,
    question: parsed.question,
    summary: parsed.summary,
  };
}

export function isStartupError(err: unknown): err is CursorAgentError {
  return err instanceof CursorAgentError;
}
