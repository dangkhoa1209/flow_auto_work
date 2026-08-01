import { API } from "./endpoints";
import { request } from "./http";

export const jobApi = {
  list(opts?: { limit?: number }) {
    const limit = opts?.limit ?? 40;
    return request<{ jobs: unknown[] }>({
      url: `${API.jobs.list}?limit=${limit}`,
      method: "GET",
    });
  },

  get(id: string) {
    return request<{ job: unknown }>({
      url: API.jobs.one(id),
      method: "GET",
    });
  },

  start(body: Record<string, unknown>) {
    return request({
      url: API.jobs.start,
      method: "POST",
      data: body,
    });
  },

  ensure(body: Record<string, unknown>) {
    return request<{ job: unknown }>({
      url: API.jobs.ensure,
      method: "POST",
      data: body,
    });
  },

  kill(id: string) {
    return request({
      url: API.jobs.kill(id),
      method: "POST",
      data: {},
    });
  },

  killAll(reason?: string) {
    return request<{
      ok: boolean;
      killed: number;
      attempted: number;
      jobIds: string[];
    }>({
      url: API.jobs.killAll,
      method: "POST",
      data: reason ? { reason } : {},
    });
  },

  approveDocs(id: string) {
    return request<{ ok: boolean; job?: unknown }>({
      url: API.jobs.approveDocs(id),
      method: "POST",
      data: {},
    });
  },

  merge(id: string, body?: { targetBranch?: string }) {
    return request({
      url: API.jobs.merge(id),
      method: "POST",
      data: body || {},
    });
  },

  continue(id: string, message: string) {
    return request({
      url: API.jobs.continue(id),
      method: "POST",
      data: { message },
    });
  },

  ask(id: string, message: string) {
    return request({
      url: API.jobs.ask(id),
      method: "POST",
      data: { message },
    });
  },

  resetWindow(id: string) {
    return request<{
      ok: boolean;
      killed: boolean;
      previousAgentId?: string | null;
      job: unknown;
    }>({
      url: API.jobs.resetWindow(id),
      method: "POST",
      data: {},
    });
  },

  setStatus(id: string, status: string, opts?: { force?: boolean }) {
    return request<{ job: unknown }>({
      url: API.jobs.status(id),
      method: "POST",
      data: { status, force: opts?.force },
    });
  },

  remove(id: string, opts?: { force?: boolean }) {
    const q = opts?.force ? "?force=1" : "";
    return request({
      url: `${API.jobs.one(id)}${q}`,
      method: "DELETE",
    });
  },

  progress(id: string, afterId?: number) {
    const q =
      afterId != null && afterId > 0 ? `?afterId=${afterId}` : "";
    return request({
      url: `${API.jobs.progress(id)}${q}`,
      method: "GET",
    });
  },

  commits(id: string) {
    return request({
      url: API.jobs.commits(id),
      method: "GET",
    });
  },

  diff(id: string, commit: string) {
    return request({
      url: `${API.jobs.diff(id)}?commit=${encodeURIComponent(commit)}`,
      method: "GET",
    });
  },

  revertCommit(id: string, sha: string, body?: { message?: string }) {
    return request({
      url: API.jobs.revertCommit(id, sha),
      method: "POST",
      data: body || {},
    });
  },

  commit(id: string, body?: { message?: string }) {
    return request<{ commitSha: string; job?: unknown }>({
      url: API.jobs.commit(id),
      method: "POST",
      data: body || {},
    });
  },

  discardChanges(id: string, body?: { paths?: string[] }) {
    return request<{
      all?: boolean;
      discarded?: string[];
      job?: unknown;
    }>({
      url: API.jobs.discardChanges(id),
      method: "POST",
      data: body || {},
    });
  },

  groupCommit(
    id: string,
    body?: { message?: string; title?: string; body?: string },
  ) {
    return request<{
      commitSha: string;
      groupedCount?: number;
      job?: unknown;
    }>({
      url: API.jobs.groupCommit(id),
      method: "POST",
      data: body || {},
    });
  },

  setCommitMode(id: string, commitMode: "manual" | "auto") {
    return request<{ job?: unknown }>({
      url: API.jobs.commitMode(id),
      method: "PATCH",
      data: { commitMode },
    });
  },

  createMr(id: string, body?: { targetBranch?: string }) {
    return request<{
      mrUrl: string;
      mrIid: number;
      created: boolean;
      job?: unknown;
    }>({
      url: API.jobs.createMr(id),
      method: "POST",
      data: body || {},
    });
  },

  completionActions(id: string, body: Record<string, unknown>) {
    return request({
      url: API.jobs.completionActions(id),
      method: "POST",
      data: body,
    });
  },

  googleStatus(id: string) {
    return request<{
      configured: boolean;
      authorized: boolean;
      email?: string;
      sheetIds: string[];
      scopes: string[];
      authorizedAt?: string;
      revokedAt?: string;
      pendingSheetUrls: string[];
    }>({
      url: API.jobs.googleStatus(id),
      method: "GET",
    });
  },

  googleDetect(id: string) {
    return request<{
      sheets: { spreadsheetId: string; url: string; gid?: string }[];
      includeIds: string[];
    }>({
      url: API.jobs.googleDetect(id),
      method: "GET",
    });
  },

  googleInclude(id: string, spreadsheetIds: string[]) {
    return request<{ ok: boolean; includeIds: string[]; job?: unknown }>({
      url: API.jobs.googleInclude(id),
      method: "PUT",
      data: { spreadsheetIds },
    });
  },

  googleAuthUrl(jobId: string) {
    return request<{ authUrl: string; state: string; configured: boolean }>({
      url: API.google.authUrl(jobId),
      method: "GET",
    });
  },

  googleRevoke(id: string) {
    return request<{ ok: boolean; job?: unknown }>({
      url: API.jobs.googleRevoke(id),
      method: "POST",
      data: {},
    });
  },

  googleContinue(id: string) {
    return request<{
      ok: boolean;
      enqueued?: boolean;
      reason?: string;
      job?: unknown;
    }>({
      url: API.jobs.googleContinue(id),
      method: "POST",
      data: {},
    });
  },
};
