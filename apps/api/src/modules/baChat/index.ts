import {
  appendBaMessage,
  createBaThread,
  deleteBaThread,
  getBaProject,
  getBaThread,
  getEffectiveBaFeatures,
  listBaMessages,
  listBaProjects,
  listBaThreads,
  softDeleteBaMessage,
  toPublicBaProject,
  updateBaThreadPinned,
  updateBaThreadTitle,
} from "../../workspace/baStore.js";
import { isGitRepo } from "../../workspace/clone.js";
import { AppError } from "../../utils/AppError.js";
import { publishRealtime } from "../../plugins/realtime/hub.js";
import {
  baCancelKey,
  isBaAnswerInFlight,
  kickBaChatAnswer,
  releaseBaAnswerClaim,
  stopBaThreadAgent,
  tryClaimBaAnswer,
  waitBaAnswerIdle,
} from "../../plugins/agent/baChat.js";
import { isJobKillRequested } from "../../plugins/agent/run.js";
import {
  getWorkflowChatContext,
  getChatTaskCreatePostProcess,
} from "../baWorkbench/index.js";

export async function baStopThread(userId: string, threadId: string) {
  const thread = await getBaThread(threadId);
  if (!thread || thread.userId !== userId.toLowerCase()) {
    throw new AppError("Thread not found", 404);
  }
  const cancelled = await stopBaThreadAgent(threadId);
  return { ok: true, cancelled };
}

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
    features: await getEffectiveBaFeatures(),
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

export async function baUpdateThread(
  userId: string,
  threadId: string,
  body: { title?: string; pinned?: boolean },
) {
  const thread = await getBaThread(threadId);
  if (!thread || thread.userId !== userId.toLowerCase()) {
    throw new AppError("Thread not found", 404);
  }

  let updated = thread;
  if (typeof body.title === "string") {
    const title = body.title.trim();
    if (!title) throw new AppError("title required", 400);
    if (title.length > 120) throw new AppError("title too long", 400);
    const next = await updateBaThreadTitle(threadId, title);
    if (!next) throw new AppError("Thread not found", 404);
    updated = next;
  }
  if (typeof body.pinned === "boolean") {
    const next = await updateBaThreadPinned(threadId, body.pinned);
    if (!next) throw new AppError("Thread not found", 404);
    updated = next;
  }
  if (typeof body.title !== "string" && typeof body.pinned !== "boolean") {
    throw new AppError("title or pinned required", 400);
  }
  return { thread: updated };
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

async function claimBaAnswerOrThrow(threadId: string) {
  const cancelKey = baCancelKey(threadId);
  if (isBaAnswerInFlight(threadId)) {
    if (isJobKillRequested(cancelKey)) {
      const idle = await waitBaAnswerIdle(threadId, 10_000);
      if (!idle) {
        throw new AppError(
          "Agent đang dừng — thử lại sau vài giây",
          409,
          "ba_thread_stopping",
        );
      }
    } else {
      throw new AppError(
        "Agent đang trả lời hội thoại này — dừng hoặc đợi xong rồi gửi tiếp",
        409,
        "ba_thread_busy",
      );
    }
  }
  if (!tryClaimBaAnswer(threadId)) {
    throw new AppError(
      "Agent đang trả lời hội thoại này — dừng hoặc đợi xong rồi gửi tiếp",
      409,
      "ba_thread_busy",
    );
  }
}

function kickWithWorkflowHooks(opts: {
  userId: string;
  threadId: string;
  baProjectId: string;
  question: string;
  isFirstUserMessage: boolean;
  analysisMode: boolean;
  workflowCtx: Awaited<ReturnType<typeof getWorkflowChatContext>>;
  taskCreatePost: ReturnType<typeof getChatTaskCreatePostProcess>;
}) {
  kickBaChatAnswer({
    userId: opts.userId.toLowerCase(),
    threadId: opts.threadId,
    baProjectId: opts.baProjectId,
    question: opts.question,
    isFirstUserMessage: opts.isFirstUserMessage,
    analysisMode: opts.analysisMode,
    workflowBlock: opts.workflowCtx?.workflowBlock,
    postProcessAnswer: async (answer) => {
      let out = answer;
      if (opts.workflowCtx?.postProcessAnswer) {
        const w = await opts.workflowCtx.postProcessAnswer(out);
        if (w?.trim()) out = w;
      }
      const t = await opts.taskCreatePost(out);
      if (t?.trim()) out = t;
      return out === answer ? null : out;
    },
  });
}

export async function baSendMessage(
  userId: string,
  threadId: string,
  body: { content?: string; analysisMode?: boolean },
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

  await claimBaAnswerOrThrow(threadId);

  try {
    // Resolve workflow hooks before persisting the user message so a setup
    // failure does not leave an orphan user bubble (Retry would duplicate).
    const existing = await listBaMessages(threadId);
    const workflowCtx = await getWorkflowChatContext(userId, threadId);
    const taskCreatePost = getChatTaskCreatePostProcess(
      userId,
      thread.baProjectId,
      threadId,
    );

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

    kickWithWorkflowHooks({
      userId,
      threadId,
      baProjectId: thread.baProjectId,
      question: content,
      isFirstUserMessage: existing.filter((m) => m.role === "user").length === 0,
      analysisMode: Boolean(body.analysisMode),
      workflowCtx,
      taskCreatePost,
    });

    return {
      message: userMsg,
      streaming: true,
      analysisMode: Boolean(body.analysisMode),
    };
  } catch (err) {
    releaseBaAnswerClaim(threadId);
    throw err;
  }
}

/**
 * Soft-delete the target assistant reply (default: last) and re-run the
 * preceding user question. Used for Regenerate / Retry after stream error.
 */
export async function baRegenerateMessage(
  userId: string,
  threadId: string,
  body: { messageId?: string; analysisMode?: boolean },
) {
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

  // Claim first so concurrent Send cannot append mid-regenerate.
  await claimBaAnswerOrThrow(threadId);

  try {
    const messages = await listBaMessages(threadId);
    let assistantIdx = -1;
    if (body.messageId?.trim()) {
      assistantIdx = messages.findIndex(
        (m) => m.id === body.messageId!.trim() && m.role === "assistant",
      );
    } else {
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === "assistant") {
          assistantIdx = i;
          break;
        }
      }
    }
    if (assistantIdx < 0) {
      throw new AppError("No assistant message to regenerate", 400);
    }
    // Only the tail assistant may be regenerated (avoid wiping later turns).
    const lastAssistantIdx = (() => {
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === "assistant") return i;
      }
      return -1;
    })();
    if (assistantIdx !== lastAssistantIdx) {
      throw new AppError(
        "Only the latest assistant reply can be regenerated",
        400,
      );
    }

    let userIdx = -1;
    for (let i = assistantIdx - 1; i >= 0; i--) {
      if (messages[i].role === "user") {
        userIdx = i;
        break;
      }
    }
    if (userIdx < 0) {
      throw new AppError("No user message to regenerate from", 400);
    }

    const question = messages[userIdx].content?.trim();
    if (!question) throw new AppError("User message is empty", 400);

    // Resolve workflow hooks before truncating so a setup failure keeps history.
    const workflowCtx = await getWorkflowChatContext(userId, threadId);
    const taskCreatePost = getChatTaskCreatePostProcess(
      userId,
      thread.baProjectId,
      threadId,
    );

    for (let i = messages.length - 1; i >= assistantIdx; i--) {
      await softDeleteBaMessage(messages[i].id);
    }

    kickWithWorkflowHooks({
      userId,
      threadId,
      baProjectId: thread.baProjectId,
      question,
      // Never auto-retitle on regenerate (user may have renamed the chat).
      isFirstUserMessage: false,
      analysisMode: Boolean(body.analysisMode),
      workflowCtx,
      taskCreatePost,
    });

    return { ok: true, streaming: true, question };
  } catch (err) {
    releaseBaAnswerClaim(threadId);
    throw err;
  }
}
