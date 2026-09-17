import { describe, expect, it } from "vitest";
import type { CodeAgentJobData } from "@flow/shared";
import { bullmqCodeJobId, isDistributedQueueEnabled } from "../setup.js";

describe("distributed queue setup", () => {
  it("builds stable bullmq job ids", () => {
    expect(bullmqCodeJobId("abc")).toBe("code-abc");
  });

  it("DISTRIBUTED_QUEUE defaults off", () => {
    const prev = process.env.DISTRIBUTED_QUEUE;
    delete process.env.DISTRIBUTED_QUEUE;
    expect(isDistributedQueueEnabled()).toBe(false);
    process.env.DISTRIBUTED_QUEUE = "1";
    expect(isDistributedQueueEnabled()).toBe(true);
    process.env.DISTRIBUTED_QUEUE = "true";
    expect(isDistributedQueueEnabled()).toBe(true);
    if (prev === undefined) delete process.env.DISTRIBUTED_QUEUE;
    else process.env.DISTRIBUTED_QUEUE = prev;
  });

  it("CodeAgentJobData shape has no secret fields", () => {
    const data: CodeAgentJobData = {
      jobId: "j1",
      projectId: "p1",
      ownerUsername: "dev",
      kind: "run",
      taskIid: 12,
    };
    const keys = Object.keys(data);
    expect(keys).not.toContain("cursorApiKey");
    expect(keys).not.toContain("gitlabToken");
    expect(keys).not.toContain("pat");
    expect(keys).not.toContain("password");
  });
});
