/**
 * Conversation surface: clarification answers, IDE-style continue, Q&A,
 * chat transcript and notes.
 */
import { answerTaskQuestion } from "../../plugins/agent/qa.js";
import { submitUiClarification } from "../../plugins/clarify/ui-wait.js";
import { addChatMessage, addNote, listChatMessages } from "../../db/mongo.js";
import { saveJob } from "../../job-store.js";
import { logger } from "../../logger.js";
import { jobQueue } from "../../queue.js";
import { AppError } from "../../utils/AppError.js";
import { requireJobDoc } from "./lifecycle.js";

/** Answer agent clarification from UI (replaces Teams). */
export async function submitClarification(
  jobId: string,
  input: { answer?: string },
) {
  await requireJobDoc(jobId);
  if (!input.answer?.trim()) {
    throw new AppError("answer required", 400);
  }
  const ok = submitUiClarification(jobId, input.answer);
  if (!ok) {
    throw new AppError(
      "No pending clarification waiter for this job (already answered or not waiting)",
      409,
    );
  }
  return { ok: true };
}

/**
 * Cursor-IDE-style chat on the same agent window.
 * Ask / fix / do more after DONE — keeps conversation context.
 */
export async function continueJobChat(
  jobId: string,
  input: { message?: string },
) {
  const job = await requireJobDoc(jobId);
  if (!input.message?.trim()) {
    throw new AppError("message required", 400);
  }
  try {
    return await jobQueue.followUpChat(job.id, input.message);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("IDE continue failed", { jobId: job.id, err: msg });
    throw new AppError(msg, /đang chạy|Force Stop|clarify/i.test(msg) ? 409 : 500);
  }
}

/** Freeform Q&A / review-only (prefer continueJobChat for IDE-like chat). */
export async function askJobQuestion(
  jobId: string,
  input: { question?: string },
) {
  const job = await requireJobDoc(jobId);
  if (!input.question?.trim()) {
    throw new AppError("question required", 400);
  }

  const { hasActiveAgentRun } = await import("../../plugins/agent/run.js");
  if (hasActiveAgentRun(job.id)) {
    throw new AppError(
      "Agent đang chạy trên job này — đợi xong hoặc Force Stop rồi hỏi Q&A lại",
      409,
    );
  }

  const priorChat = await listChatMessages({ jobId: job.id, limit: 40 });

  await addChatMessage({
    jobId: job.id,
    issueIid: job.issue.issueIid,
    role: "user",
    kind: "qa",
    body: input.question,
  });

  try {
    const qa = await answerTaskQuestion({
      issue: job.issue,
      question: input.question,
      jobId: job.id,
      existingAgentId: job.agentId,
      history: priorChat.map((m) => ({
        role: m.role,
        kind: m.kind,
        body: m.body,
      })),
    });
    job.agentId = qa.agentId;
    if (qa.usage) {
      job.tokenUsage = {
        inputTokens: qa.usage.inputTokens,
        outputTokens: qa.usage.outputTokens,
        totalTokens: qa.usage.totalTokens,
        lastInputTokens: qa.usage.lastInputTokens,
        contextWindow: qa.usage.contextWindow,
        contextPct: qa.usage.contextPct,
        updatedAt: qa.usage.updatedAt,
      };
    }
    await saveJob(job);
    await addChatMessage({
      jobId: job.id,
      issueIid: job.issue.issueIid,
      role: "agent",
      kind: "qa",
      body: qa.answer,
    });
    return {
      answer: qa.answer,
      agentId: qa.agentId,
      resumed: qa.resumed,
      tokenUsage: job.tokenUsage ?? null,
    };
  } catch (err) {
    logger.error("Q&A failed", { err: String(err) });
    await addChatMessage({
      jobId: job.id,
      issueIid: job.issue.issueIid,
      role: "system",
      kind: "qa",
      body: `Q&A lỗi: ${err instanceof Error ? err.message : String(err)}`,
    }).catch(() => undefined);
    throw new AppError(String(err), 500);
  }
}

export async function getJobChat(jobId: string) {
  const job = await requireJobDoc(jobId);
  const chat = await listChatMessages({ jobId: job.id, limit: 200 });
  return { chat };
}

/** Append a user chat line without calling the Q&A agent (e.g. before Bật Run). */
export async function appendJobChat(
  jobId: string,
  input: { body?: string; kind?: "qa" | "clarify" | "note" },
) {
  const job = await requireJobDoc(jobId);
  if (!input.body?.trim()) {
    throw new AppError("body required", 400);
  }
  const kind =
    input.kind === "clarify" || input.kind === "note" ? input.kind : "qa";
  const message = await addChatMessage({
    jobId: job.id,
    issueIid: job.issue.issueIid,
    role: "user",
    kind,
    body: input.body,
  });
  return { ok: true, message };
}

export async function addJobNote(jobId: string, input: { body?: string }) {
  const job = await requireJobDoc(jobId);
  if (!input.body?.trim()) {
    throw new AppError("body required", 400);
  }
  const note = await addNote({
    jobId: job.id,
    issueIid: job.issue.issueIid,
    projectPath: job.issue.projectPath,
    body: input.body,
  });
  await addChatMessage({
    jobId: job.id,
    issueIid: job.issue.issueIid,
    role: "user",
    kind: "note",
    body: input.body,
  });
  return { note };
}
