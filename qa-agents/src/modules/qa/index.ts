import { getConfig } from "../../../../src/config.js";
import {
  getRuntimeContext,
  requireRuntimeContext,
} from "../../../../src/workspace/runtime.js";
import { resolveGitlabProjectPath } from "../../../../src/workspace/creds.js";
import {
  createIssue,
  listProjectLabels,
  listProjectMembers,
} from "../../../../src/plugins/gitlab/client.js";
import { AppError } from "../../../../src/utils/AppError.js";
import { isJobBusy } from "../../../../src/types.js";
import {
  createQaJob,
  listQaJobs,
  loadQaJob,
  saveQaJob,
} from "../../job-store.js";
import { qaJobQueue } from "../../queue.js";
import {
  createQaPreset,
  deleteQaPreset,
  getQaProjectConfig,
  listQaPresets,
  updateQaPreset,
  upsertQaProjectConfig,
} from "../../store.js";
import { buildQaIssueMarkdown } from "../../plugins/issue/markdown.js";
import { uploadJobScreenshot } from "../../plugins/gitlab/upload.js";
import type { QaProjectConfig } from "../../types.js";

export async function getConfigForCurrentProject() {
  const rt = getRuntimeContext();
  if (!rt) throw new AppError("workspace required", 401, "unauthorized");
  const cfg = await getQaProjectConfig(rt.projectId);
  return (
    cfg || {
      workspaceProjectId: rt.projectId,
      stagingBaseUrl: "",
      loginPath: "/api/v1/auth/login",
      requestBodyKeys: { username: "username", password: "password" },
      tokenJsonPath: "data.accessToken",
      localStorageTokenKey: "accessToken",
      maxActions: 10,
      actionTimeoutSec: 30,
      maxConcurrentSessions: 1,
      createdAt: "",
      updatedAt: "",
    }
  );
}

export async function saveConfigForCurrentProject(
  patch: Partial<QaProjectConfig>,
) {
  const rt = getRuntimeContext();
  if (!rt) throw new AppError("workspace required", 401, "unauthorized");
  return upsertQaProjectConfig(rt.projectId, patch);
}

export async function listPresetsForCurrentProject() {
  const rt = getRuntimeContext();
  if (!rt) throw new AppError("workspace required", 401, "unauthorized");
  return listQaPresets(rt.projectId);
}

export async function addPreset(input: {
  role: string;
  username: string;
  password: string;
}) {
  const rt = getRuntimeContext();
  if (!rt) throw new AppError("workspace required", 401, "unauthorized");
  return createQaPreset({ ...input, workspaceProjectId: rt.projectId });
}

export async function patchPreset(
  id: string,
  patch: { role?: string; username?: string; password?: string },
) {
  const rt = getRuntimeContext();
  if (!rt) throw new AppError("workspace required", 401, "unauthorized");
  const updated = await updateQaPreset(id, rt.projectId, patch);
  if (!updated) throw new AppError("Preset not found", 404, "not_found");
  return updated;
}

export async function removePreset(id: string) {
  const rt = getRuntimeContext();
  if (!rt) throw new AppError("workspace required", 401, "unauthorized");
  const ok = await deleteQaPreset(id, rt.projectId);
  if (!ok) throw new AppError("Preset not found", 404, "not_found");
  return { ok: true };
}

export async function createAndEnqueueJob(input: {
  targetUrl: string;
  presetId: string;
  testcase: string;
}) {
  const rt = getRuntimeContext();
  if (!rt) throw new AppError("workspace required", 401, "unauthorized");
  if (!input.targetUrl?.trim()) {
    throw new AppError("targetUrl required", 400);
  }
  if (!input.presetId?.trim()) {
    throw new AppError("presetId required", 400);
  }
  if (!input.testcase?.trim()) {
    throw new AppError("testcase required", 400);
  }
  const presets = await listQaPresets(rt.projectId);
  const preset = presets.find((p) => p.id === input.presetId);
  if (!preset) throw new AppError("Preset not found", 404, "not_found");

  const job = await createQaJob({
    targetUrl: input.targetUrl,
    presetId: input.presetId,
    presetRole: preset.role,
    testcase: input.testcase,
  });
  qaJobQueue.enqueue(job.id);
  return job;
}

export async function listJobsForCurrentProject() {
  const rt = getRuntimeContext();
  if (!rt) throw new AppError("workspace required", 401, "unauthorized");
  const jobs = await listQaJobs({ workspaceProjectId: rt.projectId });
  return { jobs, queue: qaJobQueue.snapshot() };
}

export async function getJob(jobId: string) {
  const job = await loadQaJob(jobId);
  if (!job) throw new AppError("Job not found", 404, "not_found");
  return job;
}

export async function adjustJob(jobId: string, note: string) {
  const job = await loadQaJob(jobId);
  if (!job) throw new AppError("Job not found", 404, "not_found");
  if (
    job.status !== "awaiting_qa_review" &&
    job.status !== "needs_human_intervention"
  ) {
    throw new AppError(
      "Job is not awaiting review/intervention",
      409,
      "invalid_status",
    );
  }
  if (!note?.trim()) throw new AppError("note required", 400);
  if (isJobBusy(job.status)) {
    throw new AppError("Job is busy", 409, "busy");
  }
  job.status = "queued";
  await saveQaJob(job);
  qaJobQueue.enqueue(jobId, note.trim());
  return job;
}

export async function killJob(jobId: string) {
  qaJobQueue.kill(jobId);
  const job = await loadQaJob(jobId);
  return job;
}

export async function approveJob(
  jobId: string,
  opts: {
    title?: string;
    description?: string;
    assignees?: string[];
    labels?: string[];
    milestoneId?: number;
  },
) {
  const job = await loadQaJob(jobId);
  if (!job) throw new AppError("Job not found", 404, "not_found");
  if (
    job.status !== "awaiting_qa_review" &&
    job.status !== "needs_human_intervention"
  ) {
    throw new AppError("Job is not awaiting review", 409, "invalid_status");
  }
  if (!job.qa) throw new AppError("Missing QA payload", 400);

  let screenshotMdUrl: string | undefined;
  const shot = job.qa.screenshotPaths?.[0];
  if (shot) {
    try {
      const up = await uploadJobScreenshot(job.id, shot);
      screenshotMdUrl = up.url.startsWith("http")
        ? up.url
        : up.markdown.match(/\(([^)]+)\)/)?.[1] || up.url;
    } catch (err) {
      throw new AppError(
        `Screenshot upload failed: ${err instanceof Error ? err.message : String(err)}`,
        502,
        "upload_failed",
      );
    }
  }

  const description =
    opts.description?.trim() ||
    job.qa.draftMarkdown ||
    buildQaIssueMarkdown({
      qa: job.qa,
      screenshotMarkdownUrl: screenshotMdUrl,
      functionalSummary: job.summary,
    });

  let finalDescription = description;
  if (
    screenshotMdUrl &&
    !finalDescription.includes(screenshotMdUrl) &&
    !finalDescription.includes("![Bug Screenshot]")
  ) {
    finalDescription = buildQaIssueMarkdown({
      qa: job.qa,
      screenshotMarkdownUrl: screenshotMdUrl,
      functionalSummary: job.summary || job.qa.testcase,
    });
  }

  const title =
    opts.title?.trim() ||
    job.qa.draftTitle ||
    `QA Bug: ${job.qa.testcase.slice(0, 72)}`;

  const created = await createIssue({
    title,
    description: finalDescription,
    labels: opts.labels,
    assignees: opts.assignees,
    milestoneId: opts.milestoneId,
  });

  job.qa.createdIssueIid = created.iid;
  job.qa.createdIssueUrl = created.webUrl;
  job.issue = {
    ...job.issue,
    projectId: created.projectId,
    issueIid: created.iid,
    issueId: created.id,
    title: created.title,
    description: created.description,
    labels: created.labels,
    url: created.webUrl,
    action: "qa",
  };
  job.status = "succeeded";
  job.handedOffAt = new Date().toISOString();
  job.summary = job.summary || title;
  await saveQaJob(job);
  return { job, issue: created };
}

export async function metaMembersLabelsMilestones() {
  const [members, labels, milestones] = await Promise.all([
    listProjectMembers(),
    listProjectLabels(),
    listProjectMilestones(),
  ]);
  return { members, labels, milestones };
}

async function listProjectMilestones(): Promise<
  Array<{ id: number; title: string; state: string }>
> {
  const config = getConfig();
  const token = requireRuntimeContext().gitlabToken;
  const project = encodeURIComponent(resolveGitlabProjectPath());
  const url = `${config.GITLAB_BASE_URL.replace(/\/$/, "")}/api/v4/projects/${project}/milestones?state=active&per_page=100`;
  const res = await fetch(url, {
    headers: { "PRIVATE-TOKEN": token },
  });
  if (!res.ok) {
    return [];
  }
  const data = (await res.json()) as Array<{
    id: number;
    title: string;
    state: string;
  }>;
  return data.map((m) => ({ id: m.id, title: m.title, state: m.state }));
}
