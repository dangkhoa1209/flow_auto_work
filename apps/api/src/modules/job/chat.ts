/**
 * Conversation surface: IDE-style continue, Q&A, chat transcript and notes.
 * Clarification is chat-only — agent posts questions; user replies via continue.
 */
import { addChatMessage, listChatMessages } from "../../models/chat.js";
import { addNote } from "../../models/note.js";
import { logger } from "../../logger.js";
import { jobQueue } from "../../queue.js";
import { AppError } from "../../utils/AppError.js";
import { requireJobDoc } from "./lifecycle.js";
import { requireProjectLocalClone } from "../../workspace/resolve.js";

/**
 * Enqueue IDE follow-up from chat Send (runs via job queue — HTTP returns immediately).
 * Ask / fix / do more after DONE — also answers agent clarification questions.
 */
export async function continueJobChat(
  jobId: string,
  input: { message?: string },
) {
  const job = await requireJobDoc(jobId);
  if (!input.message?.trim()) {
    throw new AppError("message required", 400);
  }
  if (job.workspaceProjectId) {
    await requireProjectLocalClone(job.workspaceProjectId);
  }
  try {
    return await jobQueue.followUpChat(job.id, input.message);
  } catch (err) {
    if (err instanceof AppError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("IDE continue enqueue failed", { jobId: job.id, err: msg });
    throw new AppError(msg, /running|Force Stop|hàng chờ/i.test(msg) ? 409 : 500);
  }
}

/** Freeform Q&A / review-only — enqueued like Send (HTTP returns immediately). */
export async function askJobQuestion(
  jobId: string,
  input: { question?: string },
) {
  const job = await requireJobDoc(jobId);
  if (!input.question?.trim()) {
    throw new AppError("question required", 400);
  }
  if (job.workspaceProjectId) {
    await requireProjectLocalClone(job.workspaceProjectId);
  }
  try {
    return await jobQueue.askOnlyChat(job.id, input.question);
  } catch (err) {
    if (err instanceof AppError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("Ask only enqueue failed", { jobId: job.id, err: msg });
    throw new AppError(msg, /running|Force Stop|hàng chờ/i.test(msg) ? 409 : 500);
  }
}

/** Senior QC testcases from task + code → comment on GitLab issue. */
export async function enqueueJobTestcases(jobId: string) {
  const job = await requireJobDoc(jobId);
  if (job.workspaceProjectId) {
    await requireProjectLocalClone(job.workspaceProjectId);
  }
  try {
    return await jobQueue.enqueueGenerateTestcases(job.id);
  } catch (err) {
    if (err instanceof AppError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("Generate testcases enqueue failed", {
      jobId: job.id,
      err: msg,
    });
    throw new AppError(msg, /running|Force Stop|issue/i.test(msg) ? 409 : 500);
  }
}

export async function getJobChat(jobId: string) {
  const job = await requireJobDoc(jobId);
  const chat = await listChatMessages({ jobId: job.id, limit: 200 });
  return { chat };
}

/** Append a user chat line without calling the Q&A agent (e.g. before Run). */
export async function appendJobChat(
  jobId: string,
  input: { body?: string; kind?: "qa" | "note" },
) {
  const job = await requireJobDoc(jobId);
  if (!input.body?.trim()) {
    throw new AppError("body required", 400);
  }
  const kind = input.kind === "note" ? "note" : "qa";
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
