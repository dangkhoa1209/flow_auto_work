import { afterEach, describe, expect, it } from "vitest";
import {
  clearJobProgress,
  getJobProgress,
} from "../../../plugins/agent/progress.js";
import type { JobRecord } from "../../../types.js";
import { pushMergeOpHistory } from "../merge.js";

const JOB = "merge-history-progress-job";

function bareJob(): JobRecord {
  return {
    id: JOB,
    status: "running",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    issue: {
      projectId: "1",
      projectPath: "g/p",
      issueIid: 1,
      title: "t",
      webUrl: "https://example.test",
    },
  } as JobRecord;
}

afterEach(() => {
  clearJobProgress(JOB);
});

describe("pushMergeOpHistory progress mirror", () => {
  it("does not append Progress for processing rows", () => {
    const job = bareJob();
    pushMergeOpHistory(job, {
      kind: "merge",
      status: "processing",
      message: "Merging a → b…",
    });
    expect(getJobProgress(JOB).lines).toEqual([]);
  });

  it("appends Merge success / failed / up to date lines", () => {
    const job = bareJob();
    pushMergeOpHistory(job, {
      kind: "merge",
      status: "processing",
      message: "Merging a → b…",
    });
    pushMergeOpHistory(job, {
      kind: "merge",
      status: "ok",
      source: "a",
      target: "b",
      message: "Merged a → b",
    });
    expect(getJobProgress(JOB).lines.map((l) => l.text)).toEqual([
      "Merge success — Merged a → b",
    ]);

    clearJobProgress(JOB);
    pushMergeOpHistory(job, {
      kind: "sync-base",
      status: "up_to_date",
      message: "feat already up to date with main",
    });
    expect(getJobProgress(JOB).lines.map((l) => l.text)).toEqual([
      "Sync base up to date — feat already up to date with main",
    ]);

    clearJobProgress(JOB);
    pushMergeOpHistory(job, {
      kind: "merge",
      status: "error",
      message: "push rejected",
    });
    expect(getJobProgress(JOB).lines.map((l) => l.text)).toEqual([
      "Merge failed — push rejected",
    ]);
  });

  it("replaces processing History row in place", () => {
    const job = bareJob();
    pushMergeOpHistory(job, {
      kind: "sync-base",
      status: "processing",
      message: "Syncing…",
    });
    pushMergeOpHistory(job, {
      kind: "sync-base",
      status: "ok",
      message: "Pulled main into feat",
    });
    expect(job.mergeOpHistory).toHaveLength(1);
    expect(job.mergeOpHistory?.[0]?.status).toBe("ok");
    expect(getJobProgress(JOB).lines.map((l) => l.text)).toEqual([
      "Sync base success — Pulled main into feat",
    ]);
  });
});
