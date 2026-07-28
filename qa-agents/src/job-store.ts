import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getJobDoc, upsertJobDoc } from "../../src/db/mongo.js";
import { logger } from "../../src/logger.js";
import {
  newQaJobId,
  syntheticAdhocIssueIid,
  type JobRecord,
  type QaRunState,
} from "../../src/types.js";
import { publishQaRealtime } from "./realtime/hub.js";
import { getRuntimeContext } from "../../src/workspace/runtime.js";
import { maskSecrets } from "./plugins/login/json-path.js";

export { maskSecrets } from "./plugins/login/json-path.js";

export function artifactsRoot(): string {
  return join(process.cwd(), "qa-agents", "artifacts");
}

export function jobArtifactsDir(jobId: string): string {
  return join(artifactsRoot(), jobId);
}

export async function ensureArtifactsDir(jobId: string): Promise<string> {
  const dir = jobArtifactsDir(jobId);
  await mkdir(dir, { recursive: true });
  return dir;
}

export async function saveScreenshotFile(
  jobId: string,
  filename: string,
  data: Buffer,
): Promise<string> {
  const dir = await ensureArtifactsDir(jobId);
  const safe = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
  const abs = join(dir, safe);
  await writeFile(abs, data);
  return safe;
}

export async function saveQaJob(job: JobRecord): Promise<void> {
  job.updatedAt = new Date().toISOString();
  await upsertJobDoc(job, { source: "qa-agents" });
  publishQaRealtime({
    type: "job",
    jobId: job.id,
    status: job.status,
  });
  publishQaRealtime({ type: "jobs", reason: "save", jobId: job.id });
}

export async function loadQaJob(jobId: string): Promise<JobRecord | null> {
  const doc = await getJobDoc(jobId);
  if (!doc || doc.kind !== "qa") return null;
  const { _id: _ignored, source: _src, ...job } = doc;
  return job as JobRecord;
}

export async function listQaJobs(opts?: {
  workspaceProjectId?: string;
  limit?: number;
}): Promise<JobRecord[]> {
  const { listJobDocs } = await import("../../src/db/mongo.js");
  const docs = await listJobDocs({
    kind: "qa",
    excludeQa: false,
    workspaceProjectId: opts?.workspaceProjectId,
    limit: opts?.limit ?? 50,
  });
  return docs.map((doc) => {
    const { _id: _i, source: _s, ...job } = doc;
    return job as JobRecord;
  });
}

export async function createQaJob(input: {
  targetUrl: string;
  presetId: string;
  presetRole?: string;
  testcase: string;
}): Promise<JobRecord> {
  const rt = getRuntimeContext();
  if (!rt) throw new Error("workspace context required");
  const id = newQaJobId();
  const now = new Date().toISOString();
  const iid = syntheticAdhocIssueIid(id);
  const qa: QaRunState = {
    targetUrl: input.targetUrl.trim(),
    presetId: input.presetId,
    presetRole: input.presetRole,
    testcase: input.testcase.trim(),
    actionLog: [],
    consoleErrors: [],
    networkFailures: [],
    screenshotPaths: [],
    adjustNotes: [],
  };
  const job: JobRecord = {
    id,
    status: "queued",
    kind: "qa",
    flowTaskId: id,
    ownerUsername: rt.gitlabUsername,
    workspaceProjectId: rt.projectId,
    issue: {
      projectId: rt.gitlabProjectId ?? 0,
      projectPath: rt.gitlabPath,
      issueIid: iid,
      issueId: iid,
      title: `QA: ${input.testcase.trim().slice(0, 80) || "triage"}`,
      description: input.testcase.trim(),
      labels: [],
      url: "",
      action: "qa",
    },
    qa,
    clarifyRound: 0,
    runCount: 0,
    createdAt: now,
    updatedAt: now,
  };
  await saveQaJob(job);
  logger.info("Created QA job", { jobId: id, projectId: rt.projectId });
  return job;
}

let progressSeq = 0;

export function appendQaProgress(
  jobId: string,
  kind: string,
  text: string,
): void {
  const masked = maskSecrets(text);
  progressSeq += 1;
  publishQaRealtime({
    type: "progress",
    jobId,
    live: true,
    line: {
      id: progressSeq,
      at: new Date().toISOString(),
      kind,
      text: masked,
    },
  });
}
