import {
  appendBaMessage,
  createBaThread,
  deleteBaThread,
  getBaProject,
  getBaThread,
  listBaMessages,
  listBaProjects,
  listBaThreads,
  toPublicBaProject,
} from "../../workspace/baStore.js";
import { isGitRepo } from "../../workspace/clone.js";
import { AppError } from "../../utils/AppError.js";
import { publishRealtime } from "../../plugins/realtime/hub.js";
import { kickBaChatAnswer } from "../../plugins/agent/baChat.js";

export async function baListProjects() {
  const projects = await listBaProjects();
  return {
    projects: await Promise.all(
      projects.map(async (p) => ({
        ...toPublicBaProject(p),
        ready:
          p.cloneStatus === "ready" && (await isGitRepo(p.localPath)),
      })),
    ),
  };
}

export async function baListThreads(userId: string, baProjectId?: string) {
  return { threads: await listBaThreads(userId, baProjectId) };
}

export async function baCreateThread(
  userId: string,
  body: { baProjectId?: string; title?: string },
) {
  const baProjectId = body.baProjectId?.trim();
  if (!baProjectId) throw new AppError("baProjectId required", 400);
  const project = await getBaProject(baProjectId);
  if (!project) throw new AppError("BA project not found", 404);
  const thread = await createBaThread({
    userId,
    baProjectId,
    title: body.title,
  });
  return { thread };
}

export async function baDeleteThread(userId: string, threadId: string) {
  const ok = await deleteBaThread(threadId, userId);
  if (!ok) throw new AppError("Thread not found", 404);
  return { ok: true };
}

export async function baGetMessages(userId: string, threadId: string) {
  const thread = await getBaThread(threadId);
  if (!thread || thread.userId !== userId.toLowerCase()) {
    throw new AppError("Thread not found", 404);
  }
  return { thread, messages: await listBaMessages(threadId) };
}

export async function baSendMessage(
  userId: string,
  threadId: string,
  body: { content?: string },
) {
  const content = body.content?.trim();
  if (!content) throw new AppError("content required", 400);

  const thread = await getBaThread(threadId);
  if (!thread || thread.userId !== userId.toLowerCase()) {
    throw new AppError("Thread not found", 404);
  }

  const project = await getBaProject(thread.baProjectId);
  if (!project) throw new AppError("BA project not found", 404);
  if (
    project.cloneStatus !== "ready" ||
    !(await isGitRepo(project.localPath))
  ) {
    throw new AppError(
      "Project chưa sẵn sàng — liên hệ admin",
      400,
      "ba_project_not_ready",
    );
  }

  const existing = await listBaMessages(threadId);
  const userMsg = await appendBaMessage({
    threadId,
    role: "user",
    content,
  });
  publishRealtime({
    type: "ba_message",
    userId: userId.toLowerCase(),
    threadId,
    message: userMsg,
  });

  kickBaChatAnswer({
    userId: userId.toLowerCase(),
    threadId,
    baProjectId: thread.baProjectId,
    question: content,
    isFirstUserMessage: existing.filter((m) => m.role === "user").length === 0,
  });

  return { message: userMsg, streaming: true };
}
