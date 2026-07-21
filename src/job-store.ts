import fs from "node:fs/promises";
import path from "node:path";
import type { JobRecord } from "./types.js";
import { getConfig } from "./config.js";
import { logger } from "./logger.js";

async function ensureDir() {
  const { dataDir } = getConfig();
  await fs.mkdir(path.join(dataDir, "jobs"), { recursive: true });
  return path.join(dataDir, "jobs");
}

function jobPath(id: string) {
  return path.join(getConfig().dataDir, "jobs", `${id}.json`);
}

export async function saveJob(job: JobRecord): Promise<void> {
  await ensureDir();
  job.updatedAt = new Date().toISOString();
  await fs.writeFile(jobPath(job.id), JSON.stringify(job, null, 2), "utf8");
}

export async function loadJob(id: string): Promise<JobRecord | null> {
  try {
    const raw = await fs.readFile(jobPath(id), "utf8");
    return JSON.parse(raw) as JobRecord;
  } catch {
    return null;
  }
}

export async function listJobs(): Promise<JobRecord[]> {
  const dir = await ensureDir();
  const files = await fs.readdir(dir);
  const jobs: JobRecord[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const raw = await fs.readFile(path.join(dir, file), "utf8");
      jobs.push(JSON.parse(raw) as JobRecord);
    } catch (err) {
      logger.warn("Failed to read job file", { file, err: String(err) });
    }
  }
  return jobs;
}

export async function listActiveIssueKeys(): Promise<Set<string>> {
  const jobs = await listJobs();
  const active = new Set<string>();
  for (const job of jobs) {
    if (
      job.status === "queued" ||
      job.status === "running" ||
      job.status === "awaiting_clarification"
    ) {
      active.add(`${job.issue.projectId}:${job.issue.issueIid}`);
    }
  }
  return active;
}

export function issueKey(projectId: number, issueIid: number): string {
  return `${projectId}:${issueIid}`;
}

/** Mark interrupted jobs failed after process restart (safe default). */
export async function failInterruptedJobs(): Promise<void> {
  const jobs = await listJobs();
  for (const job of jobs) {
    if (
      job.status === "queued" ||
      job.status === "running" ||
      job.status === "awaiting_clarification"
    ) {
      job.status = "failed";
      job.error =
        job.error ??
        "Interrupted by process restart. Re-assign or update the issue to retry.";
      await saveJob(job);
      logger.warn("Marked interrupted job as failed", { jobId: job.id });
    }
  }
}
