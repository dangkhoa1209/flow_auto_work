import { api } from "@/api/client";
import { API } from "@/api/endpoints";

export type BaWorkflowStepKey = "clarify" | "asIs" | "toBe" | "breakdown";

export type BaRequirementStatus = "draft" | "analyzing" | "review" | "done";

export type BaRequirementStep = {
  key: BaWorkflowStepKey;
  content: string;
  ranAt: string;
};

export type BaRequirement = {
  id: string;
  userId: string;
  baProjectId: string;
  title: string;
  /** Yêu cầu gốc — từ khách hàng / PD. */
  rawContent: string;
  /** BA phân tích / đàm phán — điều chỉnh của BA. */
  baNote?: string | null;
  status: BaRequirementStatus;
  steps: BaRequirementStep[];
  linkedThreadId?: string | null;
  workflowChatVersion?: number;
  /** YC gốc / BA đàm phán đã đổi sau lần phân tích gần nhất. */
  inputStale?: boolean;
  createdAt: string;
  updatedAt: string;
};

export type BaTaskDraftStatus =
  | "draft"
  | "approved"
  | "published"
  | "rejected";

export type BaTaskDraft = {
  id: string;
  userId: string;
  baProjectId: string;
  requirementId?: string | null;
  threadId?: string | null;
  messageId?: string | null;
  title: string;
  description: string;
  labels: string[];
  acceptanceCriteria: string[];
  /** Ghi chú kỹ thuật cho Dev — lưu riêng, hiển thị riêng. */
  devNotes?: string | null;
  /** Có đưa devNotes vào issue khi lên GitLab không. */
  includeDevNotes?: boolean;
  milestone?: string | null;
  status: BaTaskDraftStatus;
  gitlabIid?: number | null;
  gitlabUrl?: string | null;
  createdAt: string;
  updatedAt: string;
};

export const WORKFLOW_STEPS: {
  key: BaWorkflowStepKey;
  label: string;
  hint: string;
}[] = [
  {
    key: "clarify",
    label: "1. Làm rõ",
    hint: "Thẩm định YC, phạm vi IN/OUT — chỉ dừng nếu YC không phải yêu cầu nghiệp vụ",
  },
  {
    key: "asIs",
    label: "2. Hiện trạng",
    hint: "Sản phẩm đang có gì (đúng tên UI, thuần nghiệp vụ)",
  },
  {
    key: "toBe",
    label: "3. Phân tích",
    hint: "Spec BA: màn hình, logic, popup, rủi ro",
  },
  {
    key: "breakdown",
    label: "4. Kết quả phân tích",
    hint: "Một task cho cả YC — trọng tâm, chỉnh tiếp qua chat",
  },
];

export const WORKFLOW_STEP_ORDER: BaWorkflowStepKey[] = [
  "clarify",
  "asIs",
  "toBe",
  "breakdown",
];

export const baApi = {
  getProjectGitlabMeta(baProjectId: string) {
    return api<{
      currentUser: string;
      members: Array<{ id: number; username: string; name: string }>;
      labels: Array<{
        name: string;
        color?: string;
        textColor?: string;
        description?: string;
      }>;
      milestones: Array<{ id: number; title: string; state?: string }>;
    }>(API.ba.projectGitlabMeta(baProjectId));
  },

  listRequirements(baProjectId?: string) {
    const qs = baProjectId
      ? `?baProjectId=${encodeURIComponent(baProjectId)}`
      : "";
    return api<{ requirements: BaRequirement[] }>(
      `${API.ba.requirements}${qs}`,
    );
  },

  createRequirement(data: {
    baProjectId: string;
    title?: string;
    rawContent: string;
    baNote?: string;
    linkedThreadId?: string;
  }) {
    return api<{ requirement: BaRequirement }>(API.ba.requirements, {
      method: "POST",
      body: JSON.stringify(data),
    });
  },

  getRequirement(id: string) {
    return api<{
      requirement: BaRequirement;
      taskDrafts: BaTaskDraft[];
      workflowChatStale?: boolean;
      threadChatVersion?: number;
      stepsChatVersion?: number;
    }>(API.ba.requirement(id));
  },

  updateRequirement(
    id: string,
    data: Partial<{
      title: string;
      rawContent: string;
      baNote: string | null;
      status: BaRequirementStatus;
    }>,
  ) {
    return api<{ requirement: BaRequirement }>(API.ba.requirement(id), {
      method: "PATCH",
      body: JSON.stringify(data),
    });
  },

  deleteRequirement(id: string) {
    return api<{ ok: boolean }>(API.ba.requirement(id), { method: "DELETE" });
  },

  runWorkflowStep(id: string, step: BaWorkflowStepKey) {
    return api<{
      status: "started";
      requirementId: string;
      step: BaWorkflowStepKey;
    }>(API.ba.requirementRunStep(id), {
      method: "POST",
      body: JSON.stringify({ step }),
    });
  },

  stopWorkflow(id: string) {
    return api<{ ok: boolean; cancelled: boolean }>(API.ba.requirementStop(id), {
      method: "POST",
    });
  },

  ensureRequirementThread(id: string) {
    return api<{ requirement: BaRequirement; threadId: string }>(
      API.ba.requirementEnsureThread(id),
      { method: "POST" },
    );
  },

  listTaskDrafts(opts?: {
    baProjectId?: string;
    requirementId?: string;
    status?: BaTaskDraftStatus;
  }) {
    const params = new URLSearchParams();
    if (opts?.baProjectId) params.set("baProjectId", opts.baProjectId);
    if (opts?.requirementId) params.set("requirementId", opts.requirementId);
    if (opts?.status) params.set("status", opts.status);
    const qs = params.toString() ? `?${params}` : "";
    return api<{ taskDrafts: BaTaskDraft[] }>(`${API.ba.taskDrafts}${qs}`);
  },

  createTaskDraft(data: {
    baProjectId: string;
    title: string;
    description?: string;
    labels?: string[];
    acceptanceCriteria?: string[];
    devNotes?: string;
    includeDevNotes?: boolean;
    milestone?: string;
    requirementId?: string;
    threadId?: string;
    messageId?: string;
  }) {
    return api<{ taskDraft: BaTaskDraft }>(API.ba.taskDrafts, {
      method: "POST",
      body: JSON.stringify(data),
    });
  },

  updateTaskDraft(
    id: string,
    data: Partial<{
      title: string;
      description: string;
      labels: string[];
      acceptanceCriteria: string[];
      devNotes: string | null;
      includeDevNotes: boolean;
      milestone?: string | null;
      status: BaTaskDraftStatus;
    }>,
  ) {
    return api<{ taskDraft: BaTaskDraft }>(API.ba.taskDraft(id), {
      method: "PATCH",
      body: JSON.stringify(data),
    });
  },

  deleteTaskDraft(id: string) {
    return api<{ ok: boolean }>(API.ba.taskDraft(id), { method: "DELETE" });
  },

  publishTaskDraft(
    id: string,
    opts?: {
      assignee?: string;
      milestone?: string;
      /** Task đã có trên GitLab: "update" = cập nhật issue cũ, "new" = tạo mới. */
      mode?: "update" | "new";
      includeDevNotes?: boolean;
    },
  ) {
    return api<{
      taskDraft: BaTaskDraft;
      issue: { iid: number; webUrl: string; title: string };
      mode?: "update" | "new";
    }>(API.ba.taskDraftPublish(id), {
      method: "POST",
      body: JSON.stringify(opts ?? {}),
    });
  },

  parseChatTask(content: string) {
    return api<{
      parsed: {
        title: string;
        description: string;
        acceptanceCriteria: string[];
      };
    }>(API.ba.taskDraftParseChat, {
      method: "POST",
      body: JSON.stringify({ content }),
    });
  },

  draftIssueFromThread(threadId: string) {
    return api<{
      status: "ready" | "started";
      draft?: {
        title: string;
        description: string;
        labels: string[];
        acceptanceCriteria: string[];
      };
      threadId: string;
      baProjectId: string;
      cached?: boolean;
    }>(API.ba.draftIssue(threadId), {
      method: "POST",
    });
  },
};
