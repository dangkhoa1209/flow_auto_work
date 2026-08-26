import { describe, expect, it } from "vitest";
import { BuildQueue } from "../queue.js";
import { createQueuedBuildJob } from "../store.js";
import type { BuildJob } from "../types.js";
import type { WhitelistedScript } from "../types.js";

function memoryStore() {
  const jobs = new Map<string, BuildJob>();
  return {
    jobs,
    async insert(job: BuildJob) {
      jobs.set(job.id, { ...job });
      return job;
    },
    async update(id: string, patch: Partial<Omit<BuildJob, "id">>) {
      const cur = jobs.get(id);
      if (!cur) throw new Error("missing");
      const next = { ...cur, ...patch, updatedAt: new Date().toISOString() };
      jobs.set(id, next);
      return next;
    },
    async requireJob(id: string) {
      const job = jobs.get(id);
      if (!job) throw new Error("missing");
      return job;
    },
  };
}

function memoryQueueHelpers(store: ReturnType<typeof memoryStore>) {
  return {
    listRunningJobs: async () =>
      [...store.jobs.values()].filter((j) => j.status === "running"),
    listQueuedJobIds: async () =>
      [...store.jobs.values()]
        .filter((j) => j.status === "queued")
        .sort((a, b) => a.queuedAt.localeCompare(b.queuedAt))
        .map((j) => j.id),
    claimJob: async (jobId: string) => {
      const other = [...store.jobs.values()].find((j) => j.status === "running");
      if (other) return null;
      const job = store.jobs.get(jobId);
      if (!job || job.status !== "queued") return null;
      return store.update(jobId, {
        status: "running",
        startedAt: new Date().toISOString(),
      });
    },
  };
}

const echoScript: WhitelistedScript = {
  id: "echo",
  label: "Echo",
  command: "echo ok",
  workingDir: process.cwd(),
};

describe("BuildQueue FIFO concurrency=1", () => {
  it("runs jobs one at a time in enqueue order", async () => {
    const store = memoryStore();
    const order: string[] = [];
    let concurrent = 0;
    let maxConcurrent = 0;
    const started: Array<() => void> = [];

    const helpers = memoryQueueHelpers(store);
    const queue = new BuildQueue({
      queueMax: 10,
      requireScript: () => echoScript,
      insert: store.insert,
      update: store.update,
      requireJob: store.requireJob,
      isRunning: () => false,
      cancelRun: async () => true,
      ...helpers,
      run: async (jobId) => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        order.push(jobId);
        await new Promise<void>((resolve) => {
          started.push(resolve);
        });
        concurrent -= 1;
        await store.update(jobId, {
          status: "success",
          finishedAt: new Date().toISOString(),
        });
      },
    });

    const a = await queue.trigger({ scriptId: "echo", triggeredBy: "u" });
    const b = await queue.trigger({ scriptId: "echo", triggeredBy: "u" });
    const c = await queue.trigger({ scriptId: "echo", triggeredBy: "u" });

    await new Promise((r) => setTimeout(r, 20));
    expect(queue.snapshot().concurrency).toBe(1);
    expect(queue.snapshot().running).toBe(true);
    expect(queue.snapshot().currentBuildId).toBe(a.id);
    expect(queue.snapshot().queued).toBe(2);

    started[0]?.();
    await new Promise((r) => setTimeout(r, 20));
    expect(queue.snapshot().currentBuildId).toBe(b.id);
    started[1]?.();
    await new Promise((r) => setTimeout(r, 20));
    started[2]?.();
    await new Promise((r) => setTimeout(r, 20));

    expect(order).toEqual([a.id, b.id, c.id]);
    expect(maxConcurrent).toBe(1);
    expect(queue.snapshot().running).toBe(false);
    expect(queue.snapshot().queued).toBe(0);
  });

  it("cancels a queued job without starting it", async () => {
    const store = memoryStore();
    let ran = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const helpers = memoryQueueHelpers(store);
    const queue = new BuildQueue({
      queueMax: 10,
      requireScript: () => echoScript,
      insert: store.insert,
      update: store.update,
      requireJob: store.requireJob,
      isRunning: () => false,
      cancelRun: async () => true,
      ...helpers,
      run: async () => {
        ran += 1;
        await gate;
      },
    });

    const first = await queue.trigger({ scriptId: "echo", triggeredBy: "u" });
    const second = await queue.trigger({ scriptId: "echo", triggeredBy: "u" });
    await new Promise((r) => setTimeout(r, 20));

    const cancelled = await queue.cancel(second.id, "test");
    expect(cancelled.status).toBe("cancelled");
    expect(queue.snapshot().queuedIds).not.toContain(second.id);

    release();
    await new Promise((r) => setTimeout(r, 20));
    expect(ran).toBe(1);
    expect(store.jobs.get(first.id)).toBeTruthy();
  });

  it("refuses new work after graceful shutdown", async () => {
    const store = memoryStore();
    const helpers = memoryQueueHelpers(store);
    const queue = new BuildQueue({
      queueMax: 10,
      requireScript: () => echoScript,
      insert: store.insert,
      update: store.update,
      requireJob: store.requireJob,
      isRunning: () => false,
      cancelRun: async () => true,
      ...helpers,
      run: async () => undefined,
    });
    await queue.gracefulShutdown(50);
    await expect(
      queue.trigger({ scriptId: "echo", triggeredBy: "u" }),
    ).rejects.toMatchObject({ code: "build_shutting_down" });
  });

  it("FIFO is global across devops users (not per triggeredBy)", async () => {
    const store = memoryStore();
    const order: string[] = [];
    const triggers: string[] = [];
    let concurrent = 0;
    let maxConcurrent = 0;
    const started: Array<() => void> = [];

    const helpers = memoryQueueHelpers(store);
    const queue = new BuildQueue({
      queueMax: 10,
      requireScript: () => echoScript,
      insert: store.insert,
      update: store.update,
      requireJob: store.requireJob,
      isRunning: () => false,
      cancelRun: async () => true,
      ...helpers,
      run: async (jobId) => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        order.push(jobId);
        triggers.push(store.jobs.get(jobId)?.triggeredBy ?? "");
        await new Promise<void>((resolve) => {
          started.push(resolve);
        });
        concurrent -= 1;
        await store.update(jobId, {
          status: "success",
          finishedAt: new Date().toISOString(),
        });
      },
    });

    const a = await queue.trigger({ scriptId: "echo", triggeredBy: "dev-a" });
    const b = await queue.trigger({ scriptId: "echo", triggeredBy: "dev-b" });
    const c = await queue.trigger({ scriptId: "echo", triggeredBy: "dev-a" });

    await new Promise((r) => setTimeout(r, 20));
    expect(queue.snapshot().queued).toBe(2);
    expect(maxConcurrent).toBeLessThanOrEqual(1);

    started[0]?.();
    await new Promise((r) => setTimeout(r, 20));
    started[1]?.();
    await new Promise((r) => setTimeout(r, 20));
    started[2]?.();
    await new Promise((r) => setTimeout(r, 20));

    expect(order).toEqual([a.id, b.id, c.id]);
    expect(triggers).toEqual(["dev-a", "dev-b", "dev-a"]);
    expect(maxConcurrent).toBe(1);
  });
});

describe("createQueuedBuildJob", () => {
  it("starts in queued with no startedAt", () => {
    const job = createQueuedBuildJob({
      scriptId: "echo",
      scriptLabel: "Echo",
      command: "echo ok",
      workingDir: "/tmp",
      triggeredBy: "khoa",
    });
    expect(job.status).toBe("queued");
    expect(job.startedAt).toBeUndefined();
    expect(job.id.startsWith("bld_")).toBe(true);
  });
});
