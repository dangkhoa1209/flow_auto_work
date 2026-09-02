import { AppError } from "../../utils/AppError.js";
import {
  createBaRequirement,
  createBaTaskDraft,
  createBaThread,
  deleteBaRequirement,
  deleteBaTaskDraft,
  getBaProject,
  getBaRequirement,
  getBaRequirementByThread,
  getBaTaskDraft,
  getBaThread,
  getEffectiveBaFeatures,
  isBaThreadIssueDraftCacheValid,
  listBaMessages,
  listBaRequirements,
  listBaTaskDrafts,
  setBaThreadIssueDraftCache,
  snapshotWorkflowChatVersion,
  resolveWorkflowChatStale,
  updateBaRequirement,
  updateBaTaskDraft,
  updateBaThreadKind,
  upsertBaRequirementStep,
  type BaFeatureKey,
  type BaRequirement,
  type BaTaskDraft,
  type BaTaskDraftStatus,
  type BaWorkflowStepKey,
} from "../../workspace/baStore.js";
import { isGitRepo } from "../../workspace/clone.js";
import {
  createBaGitlabIssue,
  updateBaGitlabIssue,
} from "../../plugins/gitlab/ba-issue-create.js";
import {
  fetchBaProjectLabels,
  fetchBaProjectMembers,
  fetchBaProjectMilestones,
  resolveBaAssigneeUsername,
  resolveBaMilestoneId,
} from "../../plugins/gitlab/ba-gitlab-meta.js";
import {
  BA_WORKFLOW_STEP_LABELS,
  baBusinessLanguageRules,
  looksLikeGreetingOrNoise,
  parseResultUpdateFromChat,
  parseTaskFromWorkflowOutput,
  parseWorkflowStepGate,
  runBaWorkflowStep,
  stripResultUpdateBlock,
  type WorkflowStepGate,
} from "../../plugins/agent/baWorkflow.js";
import {
  runBaThreadIssueDraft,
  normalizeIssueDraftForForm,
} from "../../plugins/agent/baThreadIssue.js";
import { cancelActiveAgentRun, hasActiveAgentRun } from "../../plugins/agent/run.js";
import { baCancelKey } from "../../plugins/agent/baChat.js";
import { getUserByUsername } from "../../workspace/store.js";
import { decryptSecret } from "../../plugins/crypto/secrets.js";
import { logger } from "../../logger.js";
import { publishRealtime } from "../../plugins/realtime/hub.js";

async function requireBaUserGitlabPat(userId: string): Promise<string> {
  const user = await getUserByUsername(userId);
  if (!user?.gitlabTokenEnc) {
    throw new AppError(
      "Bạn cần lưu GitLab PAT cá nhân trước khi lên task",
      400,
      "ba_user_gitlab_pat_missing",
    );
  }
  return decryptSecret(user.gitlabTokenEnc);
}

async function assertProjectReady(baProjectId: string) {
  const project = await getBaProject(baProjectId);
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
  return project;
}

async function ownedRequirement(
  userId: string,
  id: string,
): Promise<BaRequirement> {
  const req = await getBaRequirement(id);
  if (!req || req.userId !== userId.toLowerCase()) {
    throw new AppError("Requirement not found", 404);
  }
  return req;
}

async function ownedTaskDraft(
  userId: string,
  id: string,
): Promise<BaTaskDraft> {
  const draft = await getBaTaskDraft(id);
  if (!draft || draft.userId !== userId.toLowerCase()) {
    throw new AppError("Task draft not found", 404);
  }
  return draft;
}

function buildIssueDescription(draft: BaTaskDraft): string {
  const parts: string[] = [];
  if (draft.description.trim()) parts.push(draft.description.trim());
  if (draft.acceptanceCriteria.length) {
    parts.push(
      "### Acceptance criteria",
      ...draft.acceptanceCriteria.map((ac) => `- ${ac}`),
    );
  }
  if (draft.includeDevNotes && draft.devNotes?.trim()) {
    parts.push("### Ghi chú kỹ thuật (cho Dev)", draft.devNotes.trim());
  }
  parts.push(
    "",
    "---",
    "_Created via Flow Auto Work — BA Workbench_",
  );
  return parts.join("\n");
}

function labelsForPublish(labels: string[]): string[] {
  return [...new Set(labels.map((l) => l.trim()).filter(Boolean))];
}

export async function baGetGitlabIssueMeta(
  userId: string,
  baProjectId: string,
) {
  const token = await requireBaUserGitlabPat(userId);
  const project = await getBaProject(baProjectId);
  if (!project) throw new AppError("BA project not found", 404);
  await assertProjectReady(baProjectId);

  const [currentUser, members, labels, milestones] = await Promise.all([
    resolveBaAssigneeUsername(token, undefined, project.gitlabHost),
    fetchBaProjectMembers(project.gitlabHost, token, project.gitlabPath),
    fetchBaProjectLabels(project.gitlabHost, token, project.gitlabPath),
    fetchBaProjectMilestones(project.gitlabHost, token, project.gitlabPath),
  ]);

  return {
    currentUser,
    members: members.map((m) => ({
      id: m.id,
      username: m.username,
      name: m.name,
    })),
    labels: labels.map((l) => ({
      name: l.name,
      color: l.color,
      textColor: l.textColor,
      description: l.description,
    })),
    milestones: milestones.map((m) => ({
      id: m.id,
      title: m.title,
      state: m.state,
    })),
  };
}

const BA_FEATURE_GUARD_LABELS: Record<BaFeatureKey, string> = {
  createIssue: "Tạo issue từ chat",
  workflow: "Phân tích yêu cầu → task",
  tasks: "Quản lý task",
};

/** Chặn API khi tính năng đang ở trạng thái hide (trừ dev mode). */
async function assertBaFeatureOn(feature: BaFeatureKey) {
  const { flags, devMode } = await getEffectiveBaFeatures();
  if (devMode || flags[feature] !== "hide") return;
  throw new AppError(
    `Tính năng "${BA_FEATURE_GUARD_LABELS[feature]}" đang tắt — liên hệ admin để mở.`,
    403,
    "ba_feature_disabled",
  );
}

export async function baListRequirements(
  userId: string,
  baProjectId?: string,
) {
  return { requirements: await listBaRequirements(userId, baProjectId) };
}

export async function baCreateRequirement(
  userId: string,
  body: {
    baProjectId?: string;
    title?: string;
    rawContent?: string;
    baNote?: string;
    linkedThreadId?: string;
  },
) {
  await assertBaFeatureOn("workflow");
  const baProjectId = body.baProjectId?.trim();
  const rawContent = body.rawContent?.trim();
  if (!baProjectId) throw new AppError("baProjectId required", 400);
  if (!rawContent) throw new AppError("rawContent required", 400);
  if (looksLikeGreetingOrNoise(rawContent)) {
    throw new AppError(
      "Yêu cầu gốc chưa phải nội dung nghiệp vụ (vd: lời chào, test). Nhập yêu cầu thật từ khách hàng / PD: ai cần gì, để làm gì.",
      400,
      "ba_requirement_unclear",
    );
  }
  await assertProjectReady(baProjectId);
  const requirement = await createBaRequirement({
    userId,
    baProjectId,
    title: body.title,
    rawContent,
    baNote: body.baNote,
    linkedThreadId: body.linkedThreadId,
  });
  return { requirement };
}

export async function baUpdateRequirement(
  userId: string,
  id: string,
  body: {
    title?: string;
    rawContent?: string;
    baNote?: string | null;
    status?: BaRequirement["status"];
  },
) {
  const existing = await ownedRequirement(userId, id);
  if (
    body.rawContent !== undefined &&
    looksLikeGreetingOrNoise(body.rawContent)
  ) {
    throw new AppError(
      "Yêu cầu gốc chưa phải nội dung nghiệp vụ — nhập yêu cầu thật (ai cần gì, để làm gì).",
      400,
      "ba_requirement_unclear",
    );
  }
  const contentChanged =
    (body.rawContent !== undefined &&
      body.rawContent.trim() !== existing.rawContent) ||
    (body.baNote !== undefined &&
      (body.baNote?.trim() || "") !== (existing.baNote || ""));
  const hasAnalysis = existing.steps.some((s) => s.content?.trim());
  // Đổi YC gốc / BA đàm phán KHÔNG xoá kết quả cũ — chỉ đánh dấu stale
  // để BA bấm "Phân tích lại" (agent sẽ đọc cả chat đã trao đổi).
  const updated = await updateBaRequirement(id, {
    title: body.title,
    rawContent: body.rawContent,
    baNote: body.baNote,
    status: body.status,
    inputStale: contentChanged && hasAnalysis ? true : undefined,
  });
  if (!updated) throw new AppError("Requirement not found", 404);
  return { requirement: updated };
}

export async function baDeleteRequirement(userId: string, id: string) {
  const ok = await deleteBaRequirement(id, userId);
  if (!ok) throw new AppError("Requirement not found", 404);
  return { ok: true };
}

export async function baGetRequirement(userId: string, id: string) {
  const requirement = await ownedRequirement(userId, id);
  const taskDrafts = await listBaTaskDrafts({
    userId,
    requirementId: id,
  });
  const chat = await resolveWorkflowChatStale(requirement);
  return {
    requirement,
    taskDrafts,
    workflowChatStale: chat.stale,
    threadChatVersion: chat.threadChatVersion,
    stepsChatVersion: chat.stepsChatVersion,
  };
}

export async function baEnsureRequirementThread(userId: string, id: string) {
  let requirement = await ownedRequirement(userId, id);
  if (requirement.linkedThreadId) {
    const existing = await getBaThread(requirement.linkedThreadId);
    if (existing) {
      if (existing.kind !== "workflow") {
        await updateBaThreadKind(existing.id, "workflow");
      }
      return { requirement, threadId: existing.id };
    }
  }
  const thread = await createBaThread({
    userId,
    baProjectId: requirement.baProjectId,
    title: `YC: ${requirement.title.slice(0, 48)}`,
    kind: "workflow",
  });
  requirement =
    (await updateBaRequirement(id, { linkedThreadId: thread.id })) ||
    requirement;
  return { requirement, threadId: thread.id };
}

function baWorkflowCancelKey(requirementId: string) {
  return `ba-wf:${requirementId}`;
}

async function persistWorkflowStepResult(
  userId: string,
  requirementId: string,
  baProjectId: string,
  step: BaWorkflowStepKey,
  content: string,
): Promise<{
  requirement: BaRequirement;
  taskDrafts: BaTaskDraft[];
  gate: WorkflowStepGate;
}> {
  let requirement = (await upsertBaRequirementStep(requirementId, {
    key: step,
    content,
    ranAt: new Date().toISOString(),
  }))!;

  let createdDrafts: BaTaskDraft[] = [];
  if (step === "breakdown") {
    const parsed = parseTaskFromWorkflowOutput(content);
    if (parsed) {
      const normalized = normalizeIssueDraftForForm({
        title: parsed.title,
        description: parsed.description,
        labels: parsed.labels,
        acceptanceCriteria: parsed.acceptanceCriteria,
      });
      const existing = await listBaTaskDrafts({
        userId,
        requirementId,
      });
      let draft: BaTaskDraft;
      if (existing.length) {
        const updated = await updateBaTaskDraft(existing[0].id, {
          title: normalized.title,
          description: normalized.description,
          labels: normalized.labels,
          acceptanceCriteria: normalized.acceptanceCriteria,
          devNotes: parsed.devNotes,
        });
        draft = updated!;
        for (const extra of existing.slice(1)) {
          await deleteBaTaskDraft(extra.id, userId);
        }
      } else {
        draft = await createBaTaskDraft({
          userId,
          baProjectId,
          requirementId,
          title: normalized.title,
          description: normalized.description,
          labels: normalized.labels,
          acceptanceCriteria: normalized.acceptanceCriteria,
          devNotes: parsed.devNotes,
        });
      }
      createdDrafts = [draft];
      requirement =
        (await updateBaRequirement(requirementId, { status: "review" })) ||
        requirement;
    }
  }

  const gate = parseWorkflowStepGate(step, content);
  if (gate.status === "invalid") {
    // Đầu vào không phải yêu cầu nghiệp vụ — flow dừng, YC quay về draft.
    requirement =
      (await updateBaRequirement(requirementId, { status: "draft" })) ||
      requirement;
  }
  const chatVersion = await snapshotWorkflowChatVersion(requirementId);
  requirement =
    (await updateBaRequirement(requirementId, {
      workflowChatVersion: chatVersion,
      inputStale: false,
    })) || requirement;
  return { requirement, taskDrafts: createdDrafts, gate };
}

export async function baRunWorkflowStep(
  userId: string,
  id: string,
  body: { step?: BaWorkflowStepKey },
) {
  await assertBaFeatureOn("workflow");
  const step = body.step;
  if (!step || !["clarify", "asIs", "toBe", "breakdown"].includes(step)) {
    throw new AppError("step must be clarify | asIs | toBe | breakdown", 400);
  }
  const uid = userId.toLowerCase();
  const requirement = await ownedRequirement(uid, id);
  await assertProjectReady(requirement.baProjectId);

  if (step === "clarify" && looksLikeGreetingOrNoise(requirement.rawContent)) {
    throw new AppError(
      "Yêu cầu gốc chưa rõ ràng — sửa lại YC trước khi chạy phân tích.",
      400,
      "ba_requirement_unclear",
    );
  }

  if (hasActiveAgentRun(baWorkflowCancelKey(id))) {
    throw new AppError("Workflow đang chạy — đợi xong hoặc dừng", 409);
  }

  await updateBaRequirement(id, { status: "analyzing" });

  void (async () => {
    try {
      publishRealtime({
        type: "ba_wf_step_progress",
        userId: uid,
        requirementId: id,
        step,
        label: BA_WORKFLOW_STEP_LABELS[step],
      });
      const content = await runBaWorkflowStep({
        baProjectId: requirement.baProjectId,
        requirement,
        step,
      });
      const result = await persistWorkflowStepResult(
        uid,
        id,
        requirement.baProjectId,
        step,
        content,
      );
      publishRealtime({
        type: "ba_wf_step_done",
        userId: uid,
        requirementId: id,
        step,
        requirement: result.requirement,
        taskDrafts: result.taskDrafts,
        gate: result.gate,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn("BA workflow step background failed", {
        requirementId: id,
        step,
        err: msg,
      });
      await updateBaRequirement(id, { status: "draft" });
      publishRealtime({
        type: "ba_wf_step_error",
        userId: uid,
        requirementId: id,
        step,
        error: msg,
      });
    }
  })();

  return { status: "started" as const, requirementId: id, step };
}

/** Force-stop bước workflow đang chạy (agent `ba-wf:<requirementId>`). */
export async function baStopWorkflow(userId: string, id: string) {
  const uid = userId.toLowerCase();
  await ownedRequirement(uid, id);
  const cancelled = await cancelActiveAgentRun(baWorkflowCancelKey(id));
  await updateBaRequirement(id, { status: "draft" });
  return { ok: true, cancelled };
}

export async function baListTaskDrafts(
  userId: string,
  query: { baProjectId?: string; requirementId?: string; status?: string },
) {
  const status = query.status?.trim() as BaTaskDraftStatus | undefined;
  return {
    taskDrafts: await listBaTaskDrafts({
      userId,
      baProjectId: query.baProjectId,
      requirementId: query.requirementId,
      status:
        status &&
        ["draft", "approved", "published", "rejected"].includes(status)
          ? status
          : undefined,
    }),
  };
}

export async function baCreateTaskDraft(
  userId: string,
  body: {
    baProjectId?: string;
    title?: string;
    description?: string;
    labels?: string[];
    acceptanceCriteria?: string[];
    devNotes?: string;
    includeDevNotes?: boolean;
    milestone?: string;
    requirementId?: string;
    threadId?: string;
    messageId?: string;
  },
) {
  const baProjectId = body.baProjectId?.trim();
  const title = body.title?.trim();
  if (!baProjectId) throw new AppError("baProjectId required", 400);
  if (!title) throw new AppError("title required", 400);
  await assertProjectReady(baProjectId);
  const draft = await createBaTaskDraft({
    userId,
    baProjectId,
    title,
    description: body.description,
    labels: body.labels,
    acceptanceCriteria: body.acceptanceCriteria,
    devNotes: body.devNotes,
    includeDevNotes: body.includeDevNotes,
    milestone: body.milestone,
    requirementId: body.requirementId,
    threadId: body.threadId,
    messageId: body.messageId,
  });
  return { taskDraft: draft };
}

export async function baUpdateTaskDraft(
  userId: string,
  id: string,
  body: Partial<{
    title: string;
    description: string;
    labels: string[];
    acceptanceCriteria: string[];
    devNotes: string | null;
    includeDevNotes: boolean;
    milestone: string | null;
    status: BaTaskDraftStatus;
  }>,
) {
  await ownedTaskDraft(userId, id);
  const updated = await updateBaTaskDraft(id, body);
  if (!updated) throw new AppError("Task draft not found", 404);
  return { taskDraft: updated };
}

export async function baDeleteTaskDraft(userId: string, id: string) {
  const ok = await deleteBaTaskDraft(id, userId);
  if (!ok) throw new AppError("Task draft not found", 404);
  return { ok: true };
}

export async function baPublishTaskDraft(
  userId: string,
  id: string,
  body: {
    assignee?: string;
    milestone?: string;
    /** Khi task đã lên GitLab: "update" = cập nhật issue cũ, "new" = tạo issue mới. */
    mode?: "update" | "new";
    includeDevNotes?: boolean;
  },
) {
  let draft = await ownedTaskDraft(userId, id);
  const alreadyPublished = draft.status === "published" && draft.gitlabIid;
  if (alreadyPublished && body.mode !== "update" && body.mode !== "new") {
    throw new AppError(
      `Task đã lên GitLab #${draft.gitlabIid} — chọn cập nhật task cũ hay tạo task mới`,
      409,
      "ba_task_already_published",
    );
  }
  if (body.includeDevNotes !== undefined) {
    draft =
      (await updateBaTaskDraft(id, {
        includeDevNotes: Boolean(body.includeDevNotes),
      })) || draft;
  }
  const milestoneTitle = (body.milestone ?? draft.milestone ?? "").trim();
  if (!milestoneTitle) {
    throw new AppError("Milestone là bắt buộc khi lên GitLab", 400);
  }
  const project = await getBaProject(draft.baProjectId);
  if (!project) throw new AppError("BA project not found", 404);
  const token = await requireBaUserGitlabPat(userId);

  const milestoneId = await resolveBaMilestoneId(
    project.gitlabHost,
    token,
    project.gitlabPath,
    milestoneTitle,
  );
  if (!milestoneId) {
    throw new AppError(`Milestone không tồn tại: ${milestoneTitle}`, 400);
  }

  const assignee = await resolveBaAssigneeUsername(
    token,
    body.assignee,
    project.gitlabHost,
  );

  const labels = labelsForPublish(draft.labels);

  if (alreadyPublished && body.mode === "update") {
    const issue = await updateBaGitlabIssue({
      gitlabHost: project.gitlabHost,
      token,
      gitlabPath: project.gitlabPath,
      iid: draft.gitlabIid!,
      title: draft.title,
      description: buildIssueDescription(draft),
      labels,
      assignees: [assignee],
      milestoneId,
    });
    const updated = await updateBaTaskDraft(id, {
      status: "published",
      gitlabIid: issue.iid,
      gitlabUrl: issue.webUrl,
      milestone: milestoneTitle,
    });
    return { taskDraft: updated, issue, mode: "update" as const };
  }

  const created = await createBaGitlabIssue({
    gitlabHost: project.gitlabHost,
    token,
    gitlabPath: project.gitlabPath,
    title: draft.title,
    description: buildIssueDescription(draft),
    labels,
    assignees: [assignee],
    milestoneId,
  });

  const updated = await updateBaTaskDraft(id, {
    status: "published",
    gitlabIid: created.iid,
    gitlabUrl: created.webUrl,
    milestone: milestoneTitle,
  });

  return { taskDraft: updated, issue: created, mode: "new" as const };
}

function baIssueDraftCancelKey(threadId: string) {
  return `ba-issue:${threadId}`;
}

function publishIssueDraftProgress(
  userId: string,
  threadId: string,
  label: string,
  step?: string,
) {
  publishRealtime({
    type: "ba_issue_draft_progress",
    userId: userId.toLowerCase(),
    threadId,
    label,
    step,
  });
}

/**
 * Start issue draft from chat.
 * - Cache hit → `{ status: "ready", draft }` (sync)
 * - Else kick agent in background → `{ status: "started" }` (HTTP 202);
 *   result arrives via SSE `ba_issue_draft_done` / `ba_issue_draft_error`.
 */
export async function baDraftIssueFromThread(userId: string, threadId: string) {
  await assertBaFeatureOn("createIssue");
  const uid = userId.toLowerCase();
  const thread = await getBaThread(threadId);
  if (!thread || thread.userId !== uid) {
    throw new AppError("Thread not found", 404);
  }
  if (hasActiveAgentRun(baCancelKey(threadId))) {
    throw new AppError(
      "Agent đang trả lời — đợi xong rồi bấm Create issue",
      409,
    );
  }
  if (hasActiveAgentRun(baIssueDraftCancelKey(threadId))) {
    throw new AppError("Đang soạn issue — đợi xong hoặc mở lại modal", 409);
  }
  await assertProjectReady(thread.baProjectId);
  await requireBaUserGitlabPat(uid);
  const messages = await listBaMessages(threadId);
  const hasContent = messages.some((m) => m.content?.trim());
  if (!hasContent) {
    throw new AppError("Chưa có hội thoại để tổng hợp issue", 400);
  }

  const requestVersion = thread.issueDraftVersion ?? 0;
  const cached = thread.issueDraftCache;
  if (isBaThreadIssueDraftCacheValid(thread, cached)) {
    logger.info("BA thread issue draft cache hit", {
      threadId,
      version: requestVersion,
    });
    return {
      status: "ready" as const,
      draft: normalizeIssueDraftForForm(cached!.draft),
      threadId,
      baProjectId: thread.baProjectId,
      cached: true,
    };
  }

  void (async () => {
    try {
      publishIssueDraftProgress(uid, threadId, "Đang review hội thoại…", "start");
      const draft = await runBaThreadIssueDraft({
        threadId,
        baProjectId: thread.baProjectId,
        onProgress: (label, step) =>
          publishIssueDraftProgress(uid, threadId, label, step),
      });
      const fresh = await getBaThread(threadId);
      const currentVersion = fresh?.issueDraftVersion ?? 0;
      if (currentVersion === requestVersion) {
        await setBaThreadIssueDraftCache(threadId, requestVersion, draft);
      } else {
        logger.info("BA thread issue draft skip cache — version changed during run", {
          threadId,
          requestVersion,
          currentVersion,
        });
      }
      publishRealtime({
        type: "ba_issue_draft_done",
        userId: uid,
        threadId,
        baProjectId: thread.baProjectId,
        cached: false,
        draft,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn("BA thread issue draft background failed", {
        threadId,
        err: msg,
      });
      publishRealtime({
        type: "ba_issue_draft_error",
        userId: uid,
        threadId,
        error: msg,
      });
    }
  })();

  return {
    status: "started" as const,
    threadId,
    baProjectId: thread.baProjectId,
    cached: false,
  };
}

/* ── Workflow chat → cập nhật Kết quả phân tích ── */

function formatDraftBlock(draft: BaTaskDraft): string {
  const lines = [
    `**Title:** ${draft.title}`,
    "",
    draft.description || "(chưa có mô tả)",
  ];
  if (draft.acceptanceCriteria.length) {
    lines.push(
      "",
      "**Acceptance criteria:**",
      ...draft.acceptanceCriteria.map((ac) => `- ${ac}`),
    );
  }
  if (draft.devNotes?.trim()) {
    lines.push("", "**devNotes (kỹ thuật, cho Dev):**", draft.devNotes.trim());
  }
  return lines.join("\n");
}

/**
 * Context + hậu xử lý cho chat gắn với YC workflow:
 * - Prompt block: YC gốc, BA đàm phán, Kết quả phân tích hiện tại.
 * - Khi agent xuất `resultUpdate` → cập nhật task draft (Kết quả phân tích)
 *   ngay từ chat, không cần chạy lại flow.
 */
export async function getWorkflowChatContext(
  userId: string,
  threadId: string,
): Promise<{
  workflowBlock: string;
  postProcessAnswer: (answer: string) => Promise<string | null>;
} | null> {
  const uid = userId.toLowerCase();
  const requirement = await getBaRequirementByThread(threadId);
  if (!requirement || requirement.userId !== uid) return null;

  const drafts = await listBaTaskDrafts({
    userId: uid,
    requirementId: requirement.id,
  });
  const draft = drafts[0] || null;

  const parts: string[] = [
    `## Chat này gắn với YC đang phân tích: "${requirement.title}"`,
    "",
    "### Yêu cầu gốc (khách hàng / PD)",
    requirement.rawContent.trim(),
  ];
  if (requirement.baNote?.trim()) {
    parts.push("", "### BA phân tích / đàm phán", requirement.baNote.trim());
  }
  if (draft) {
    parts.push(
      "",
      "### Kết quả phân tích hiện tại (task) — TRỌNG TÂM của chat này",
      formatDraftBlock(draft),
      "",
      `### Quy tắc cập nhật Kết quả phân tích
- Chat này **phải giữ Kết quả phân tích đồng bộ** với những gì đã chốt trong trao đổi — không để bản cũ khi Human đã chỉnh phạm vi / mô tả / cột / logic.
- Khi Human **chỉnh, bổ sung, bác bỏ, chốt thêm, hoặc trả lời câu hỏi làm rõ** liên quan nội dung task: trả lời ngắn phần thay đổi, rồi **cuối câu trả lời** xuất đúng 1 block JSON chứa **BẢN HOÀN CHỈNH** sau chỉnh sửa (đủ mọi trường, không chỉ diff):
\`\`\`json
{"resultUpdate":{"title":"…","description":"…","acceptanceCriteria":[],"devNotes":"…"}}
\`\`\`
- \`description\` = mục 1–3 đã cập nhật (bỏ mục 4); chi tiết kỹ thuật chỉ trong \`devNotes\`. \`acceptanceCriteria\` luôn \`[]\`.
- Chỉ **không** xuất block khi câu hỏi thuần hướng dẫn UI / không đụng nội dung task (vd. "nút Lưu ở đâu?").`,
    );
  } else {
    parts.push(
      "",
      "### Trạng thái",
      "Chưa có Kết quả phân tích (chưa chạy đủ flow) — chat này dùng để làm rõ yêu cầu trước khi phân tích.",
    );
  }
  parts.push("", baBusinessLanguageRules());

  const postProcessAnswer = async (answer: string): Promise<string | null> => {
    const update = parseResultUpdateFromChat(answer);
    if (!update) return null;

    const current = (
      await listBaTaskDrafts({ userId: uid, requirementId: requirement.id })
    )[0];
    let saved: BaTaskDraft | null = null;
    if (current) {
      saved = await updateBaTaskDraft(current.id, {
        title: update.title,
        description: update.description,
        acceptanceCriteria: update.acceptanceCriteria,
        devNotes: update.devNotes,
        ...(update.labels ? { labels: update.labels } : {}),
      });
    } else if (update.title) {
      saved = await createBaTaskDraft({
        userId: uid,
        baProjectId: requirement.baProjectId,
        requirementId: requirement.id,
        title: update.title,
        description: update.description,
        labels: update.labels,
        acceptanceCriteria: update.acceptanceCriteria,
        devNotes: update.devNotes,
      });
    }
    if (!saved) return null;

    const fresh =
      (await updateBaRequirement(requirement.id, { status: "review" })) ||
      requirement;
    publishRealtime({
      type: "ba_wf_step_done",
      userId: uid,
      requirementId: requirement.id,
      step: "breakdown",
      requirement: fresh,
      taskDrafts: [saved],
      gate: { status: "ok", openQuestions: [] },
    });
    logger.info("BA workflow result updated from chat", {
      requirementId: requirement.id,
      draftId: saved.id,
    });

    const cleaned = stripResultUpdateBlock(answer);
    return `${cleaned}\n\n> ✅ Đã cập nhật Kết quả phân tích.`;
  };

  return { workflowBlock: parts.join("\n"), postProcessAnswer };
}

/** Extract title/description from chat markdown for pre-fill. */
export function parseTaskFromChatContent(content: string): {
  title: string;
  description: string;
  acceptanceCriteria: string[];
} {
  const lines = content.trim().split("\n");
  let title = "";
  const descLines: string[] = [];
  const ac: string[] = [];

  for (const line of lines) {
    const tMatch = /(?:Title|Tiêu đề)\s*:+\s*(.+)/i.exec(
      line.replace(/^\*+|\*+$/g, ""),
    );
    if (tMatch && !title) {
      title = tMatch[1].replace(/^\*+|\*+$/g, "").trim();
      continue;
    }
    const hMatch = /^#\s+(.+)/.exec(line);
    if (hMatch && !title) {
      title = hMatch[1].trim();
      continue;
    }
    if (/^[-*]\s*(?:AC|Given|When|Then)/i.test(line) || /^Given\s/i.test(line)) {
      ac.push(line.replace(/^[-*]\s*/, "").trim());
    } else {
      descLines.push(line);
    }
  }

  if (!title) {
    title =
      descLines.find((l) => l.trim() && !l.startsWith("#"))?.trim().slice(0, 120) ||
      "Task từ chat";
  }

  return {
    title: title.slice(0, 200),
    description: descLines.join("\n").trim(),
    acceptanceCriteria: ac,
  };
}
