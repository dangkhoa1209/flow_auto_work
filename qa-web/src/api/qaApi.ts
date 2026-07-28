import { request } from "./http";

export const qaApi = {
  me() {
    return request<{
      user: { gitlabUsername?: string; cursorModel?: string };
      memberships: Array<{
        projectId: string;
        project?: { id: string; displayName?: string; gitlabPath?: string };
      }>;
    }>({ url: "/api/me", method: "GET" });
  },

  getConfig() {
    return request<{ config: Record<string, unknown> }>({
      url: "/api/qa/config",
      method: "GET",
    });
  },

  saveConfig(data: Record<string, unknown>) {
    return request<{ config: Record<string, unknown> }>({
      url: "/api/qa/config",
      method: "PUT",
      data,
    });
  },

  listPresets() {
    return request<{
      presets: Array<{
        id: string;
        role: string;
        username: string;
        lastUsedAt?: string;
      }>;
    }>({ url: "/api/qa/presets", method: "GET" });
  },

  createPreset(data: { role: string; username: string; password: string }) {
    return request<{ preset: { id: string; role: string; username: string } }>({
      url: "/api/qa/presets",
      method: "POST",
      data,
    });
  },

  deletePreset(id: string) {
    return request<{ ok: boolean }>({
      url: `/api/qa/presets/${encodeURIComponent(id)}`,
      method: "DELETE",
    });
  },

  listJobs() {
    return request<{ jobs: QaJob[]; queue: { queued: number; running: boolean } }>({
      url: "/api/qa/jobs",
      method: "GET",
    });
  },

  getJob(id: string) {
    return request<{ job: QaJob }>({
      url: `/api/qa/jobs/${encodeURIComponent(id)}`,
      method: "GET",
    });
  },

  createJob(data: { targetUrl: string; presetId: string; testcase: string }) {
    return request<{ job: QaJob }>({
      url: "/api/qa/jobs",
      method: "POST",
      data,
    });
  },

  adjust(id: string, note: string) {
    return request<{ job: QaJob }>({
      url: `/api/qa/jobs/${encodeURIComponent(id)}/adjust`,
      method: "POST",
      data: { note },
    });
  },

  approve(
    id: string,
    data: {
      title?: string;
      description?: string;
      assignees?: string[];
      labels?: string[];
      milestoneId?: number;
    },
  ) {
    return request<{
      job: QaJob;
      issue: { iid: number; webUrl: string; title: string };
    }>({
      url: `/api/qa/jobs/${encodeURIComponent(id)}/approve`,
      method: "POST",
      data,
    });
  },

  kill(id: string) {
    return request<{ job: QaJob }>({
      url: `/api/qa/jobs/${encodeURIComponent(id)}/kill`,
      method: "POST",
    });
  },

  meta() {
    return request<{
      members: Array<{ username: string; name?: string }>;
      labels: Array<{ name: string }>;
      milestones: Array<{ id: number; title: string }>;
    }>({ url: "/api/qa/meta", method: "GET" });
  },
};

export type QaJob = {
  id: string;
  status: string;
  summary?: string;
  error?: string;
  lastQuestion?: string;
  qa?: {
    targetUrl: string;
    presetId: string;
    presetRole?: string;
    testcase: string;
    actionLog?: string[];
    consoleErrors?: Array<{ message: string; stack?: string }>;
    networkFailures?: Array<{
      url: string;
      method: string;
      status: number;
      responseBody?: string;
    }>;
    screenshotPaths?: string[];
    draftMarkdown?: string;
    draftTitle?: string;
    createdIssueUrl?: string;
  };
};
