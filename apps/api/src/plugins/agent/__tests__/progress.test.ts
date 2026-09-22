import type { SDKMessage } from "@cursor/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { subscribeRealtime } from "../../realtime/hub.js";
import {
  appendJobProgress,
  appendPromptSending,
  appendSdkMessage,
  appendSubagentDelta,
  clearJobProgress,
  getJobCapturedPlan,
  getJobProgress,
  PROGRESS_PUBLISH_MS,
  workRunOnDelta,
  workRunOnStep,
} from "../progress.js";

const JOB = "progress-format-job";

afterEach(() => {
  clearJobProgress(JOB);
  vi.useRealTimers();
});

describe("appendPromptSending", () => {
  it("logs the full prompt body in Process", () => {
    appendPromptSending(JOB, "Hello agent — do the thing");
    const { lines } = getJobProgress(JOB);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.kind).toBe("prompt");
    expect(lines[0]!.text).toContain("Sending prompt (");
    expect(lines[0]!.text).toContain("Hello agent — do the thing");
  });

  it("chunks oversized prompts so the full body is visible", () => {
    const body = "x".repeat(20_000);
    appendPromptSending(JOB, body);
    const { lines } = getJobProgress(JOB);
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(lines.every((l) => l.kind === "prompt")).toBe(true);
    const joined = lines.map((l) => l.text).join("");
    expect(joined).toContain("x".repeat(15_500));
    expect(joined).toContain("Prompt continued");
    // Reconstruct body from chunks (strip headers)
    const rebuilt = lines
      .map((l) => l.text.replace(/^[\s\S]*?:\n\n/, ""))
      .join("");
    expect(rebuilt).toBe(body);
  });
});

describe("appendJobProgress assistant coalescing", () => {
  it("concatenates stream deltas without inserting spaces", () => {
    appendJobProgress(JOB, "assistant", "main");
    appendJobProgress(JOB, "assistant", ".js");
    appendJobProgress(JOB, "assistant", " gắn ");
    appendJobProgress(JOB, "assistant", "Đ");
    appendJobProgress(JOB, "assistant", "ã");
    appendJobProgress(JOB, "assistant", " #");
    appendJobProgress(JOB, "assistant", "145");
    appendJobProgress(JOB, "assistant", "95");
    appendJobProgress(JOB, "assistant", " set");
    appendJobProgress(JOB, "assistant", "-up");
    appendJobProgress(JOB, "assistant", "-organization");

    const { lines } = getJobProgress(JOB);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.kind).toBe("assistant");
    expect(lines[0]!.text).toBe(
      "main.js gắn Đã #14595 set-up-organization",
    );
  });

  it("keeps a leading space that arrived on the next delta", () => {
    appendJobProgress(JOB, "assistant", "Hello");
    appendJobProgress(JOB, "assistant", " world");

    const { lines } = getJobProgress(JOB);
    expect(lines[0]!.text).toBe("Hello world");
  });

  it("does not drop a whitespace-only delta between tokens", () => {
    appendJobProgress(JOB, "assistant", "đoán");
    appendJobProgress(JOB, "assistant", " ");
    appendJobProgress(JOB, "assistant", "bừa");

    const { lines } = getJobProgress(JOB);
    expect(lines[0]!.text).toBe("đoán bừa");
  });

  it("still collapses status noise onto one trimmed line", () => {
    appendJobProgress(JOB, "status", "  Cursor  đang   stream…  ");
    const { lines } = getJobProgress(JOB);
    expect(lines[0]!.text).toBe("Cursor đang stream…");
  });

  it("caps coalesced assistant text at 16_000, not 8000", () => {
    appendJobProgress(JOB, "assistant", "a".repeat(15_000));
    appendJobProgress(JOB, "assistant", "b".repeat(2_000));
    const { lines } = getJobProgress(JOB);
    expect(lines[0]!.text).toHaveLength(16_000);
    expect(lines[0]!.text.endsWith("b")).toBe(true);
    expect(lines[0]!.text.includes("b")).toBe(true);
  });

  it("collapses extra newlines only at the join boundary", () => {
    appendJobProgress(JOB, "assistant", "hello\n\n");
    appendJobProgress(JOB, "assistant", "\n\nworld");
    const { lines } = getJobProgress(JOB);
    expect(lines[0]!.text).toBe("hello\n\nworld");
  });
});

describe("subagent progress", () => {
  it("formats Task tool_call with subagent name + description", () => {
    appendSdkMessage(JOB, {
      type: "tool_call",
      agent_id: "a",
      run_id: "r",
      call_id: "c1",
      name: "task",
      status: "running",
      args: {
        description: "Find TimekeeperSync",
        prompt: "…",
        subagentType: { kind: "custom", name: "explore" },
      },
    } as Parameters<typeof appendSdkMessage>[1]);

    const { lines } = getJobProgress(JOB);
    expect(lines[0]!.kind).toBe("tool");
    expect(lines[0]!.text).toBe(
      "subagent · explore: Find TimekeeperSync…",
    );
  });

  it("coalesces nested subagent text deltas under kind task", () => {
    appendSubagentDelta(JOB, "call-abc", {
      type: "text-delta",
      text: "Found ",
    });
    appendSubagentDelta(JOB, "call-abc", {
      type: "text-delta",
      text: "run.ts",
    });
    appendSubagentDelta(JOB, "call-abc", {
      type: "tool-call-started",
      toolCall: { type: "grep", args: { pattern: "foo" } },
    });

    const { lines } = getJobProgress(JOB);
    expect(lines[0]!.kind).toBe("task");
    expect(lines[0]!.text).toBe("Found run.ts");
    expect(lines[1]!.kind).toBe("tool");
    expect(lines[1]!.text).toContain("[sub call-abc]");
    expect(lines[1]!.text).toContain("grep: foo");
  });

  it("prefixes tools from a nested agent_id on the stream", () => {
    appendSdkMessage(JOB, {
      type: "system",
      agent_id: "root-agent-1",
      run_id: "r",
      subtype: "init",
    } as Parameters<typeof appendSdkMessage>[1]);
    appendSdkMessage(JOB, {
      type: "tool_call",
      agent_id: "root-agent-1",
      run_id: "r",
      call_id: "t1",
      name: "task",
      status: "running",
      args: {
        description: "Explore progress",
        prompt: "…",
        subagentType: { kind: "custom", name: "explore" },
      },
    } as Parameters<typeof appendSdkMessage>[1]);
    appendSdkMessage(JOB, {
      type: "tool_call",
      agent_id: "nested-sub-99",
      run_id: "r2",
      call_id: "c2",
      name: "Shell",
      status: "running",
      args: { command: "pwd" },
    } as Parameters<typeof appendSdkMessage>[1]);

    const { lines } = getJobProgress(JOB);
    const tools = lines.filter((l) => l.kind === "tool");
    expect(tools[0]!.text).toBe("subagent · explore: Explore progress…");
    expect(tools[1]!.text).toBe("[sub nested-s] Shell: pwd…");
  });

  it("replays Task conversationSteps when nested tools were not streamed live", () => {
    appendSdkMessage(JOB, {
      type: "system",
      agent_id: "root-a",
      run_id: "r",
      subtype: "init",
    } as Parameters<typeof appendSdkMessage>[1]);
    appendSdkMessage(JOB, {
      type: "tool_call",
      agent_id: "root-a",
      run_id: "r",
      call_id: "task-1",
      name: "task",
      status: "completed",
      args: {
        description: "Find files",
        prompt: "…",
        subagentType: { kind: "custom", name: "explore" },
      },
      result: {
        status: "success",
        value: {
          isBackground: false,
          backgroundReason: "agentRequest",
          agentId: "sub-xyz-001",
          conversationSteps: [
            {
              type: "toolCall",
              message: {
                type: "Shell",
                args: { command: "ls apps/api" },
              },
            },
            {
              type: "assistantMessage",
              message: { text: "Found progress.ts" },
            },
          ],
        },
      },
    } as Parameters<typeof appendSdkMessage>[1]);

    const { lines } = getJobProgress(JOB);
    expect(lines.some((l) => l.text.includes("[sub sub-xyz-]"))).toBe(true);
    expect(lines.some((l) => l.text.includes("Shell: ls apps/api"))).toBe(true);
    expect(lines.some((l) => l.kind === "task" && l.text.includes("Found progress.ts"))).toBe(
      true,
    );
  });

  it("workRunOnStep expands Task conversationSteps without duplicating parent tools", () => {
    const onStep = workRunOnStep(JOB);
    expect(onStep).toBeDefined();
    onStep!({
      step: {
        type: "toolCall",
        message: {
          type: "task",
          args: { description: "Explore" },
          result: {
            status: "success",
            value: {
              agentId: "sub-onstep-1",
              conversationSteps: [
                {
                  type: "toolCall",
                  message: {
                    type: "Shell",
                    args: { command: "pwd" },
                  },
                },
              ],
            },
          },
        },
      } as never,
    });
    const { lines } = getJobProgress(JOB);
    expect(lines.some((l) => l.text.includes("[sub sub-onst]"))).toBe(true);
    expect(lines.some((l) => l.text.includes("Shell: pwd"))).toBe(true);
  });

  it("workRunOnDelta maps tool-call-delta.taskUpdate to [sub …] Process lines", () => {
    const onDelta = workRunOnDelta(JOB);
    expect(onDelta).toBeDefined();
    onDelta!({
      update: {
        type: "tool-call-delta",
        callId: "task-live-1",
        modelCallId: "m1",
        taskUpdate: {
          type: "tool-call-started",
          callId: "inner-shell",
          toolCall: { type: "shell", args: { command: "ls" } },
        },
      } as never,
    });
    const { lines } = getJobProgress(JOB);
    expect(lines.some((l) => l.text.includes("[sub task-liv]"))).toBe(true);
    expect(lines.some((l) => /shell:\s*ls/i.test(l.text))).toBe(true);
  });
});

describe("appendJobProgress realtime throttle", () => {
  it("publishes the first assistant line immediately, then throttles coalesced deltas", () => {
    vi.useFakeTimers();
    const texts: string[] = [];
    const unsub = subscribeRealtime((ev) => {
      if (ev.type === "progress" && ev.jobId === JOB) texts.push(ev.line.text);
    });

    appendJobProgress(JOB, "assistant", "a");
    appendJobProgress(JOB, "assistant", "b");
    appendJobProgress(JOB, "assistant", "c");
    expect(texts).toEqual(["a"]);

    vi.advanceTimersByTime(PROGRESS_PUBLISH_MS);
    expect(texts).toEqual(["a", "abc"]);
    unsub();
  });

  it("flushes coalesced text when a new kind arrives", () => {
    vi.useFakeTimers();
    const events: Array<{ kind: string; text: string }> = [];
    const unsub = subscribeRealtime((ev) => {
      if (ev.type === "progress" && ev.jobId === JOB) {
        events.push({ kind: ev.line.kind, text: ev.line.text });
      }
    });

    appendJobProgress(JOB, "assistant", "hello");
    appendJobProgress(JOB, "assistant", "!");
    appendJobProgress(JOB, "status", "finished");

    expect(events).toEqual([
      { kind: "assistant", text: "hello" },
      { kind: "assistant", text: "hello!" },
      { kind: "status", text: "finished" },
    ]);
    unsub();
  });
});

describe("appendJobProgress buffer eviction", () => {
  it("batch-trims to MAX_LINES after 1.5x overflow", () => {
    for (let i = 1; i <= 601; i++) {
      appendJobProgress(JOB, "status", `line-${i}`);
    }
    const { lines } = getJobProgress(JOB);
    expect(lines).toHaveLength(400);
    expect(lines[0]!.text).toBe("line-202");
    expect(lines[399]!.text).toBe("line-601");
  });
});

function toolCall(
  name: string,
  args: unknown,
  status: "running" | "completed" | "error" = "completed",
): SDKMessage {
  return {
    type: "tool_call",
    agent_id: "a",
    run_id: "r",
    call_id: "c",
    name,
    status,
    args,
  };
}

describe("appendSdkMessage tool labels", () => {
  it("unwraps MCP custom tool name + question", () => {
    appendSdkMessage(
      JOB,
      toolCall(
        "mcp",
        {
          toolName: "code_map_query",
          providerIdentifier: "custom-user-tools",
          args: { question: "TimekeeperSync" },
        },
        "running",
      ),
    );
    const { lines } = getJobProgress(JOB);
    expect(lines[0]!.kind).toBe("tool");
    expect(lines[0]!.text).toBe("code_map_query: TimekeeperSync…");
  });

  it("unwraps snake_case MCP fields and path tools", () => {
    appendSdkMessage(
      JOB,
      toolCall("mcp", {
        tool_name: "code_map_path",
        args: { from: "AuthModule", to: "Database" },
      }),
    );
    const { lines } = getJobProgress(JOB);
    expect(lines[0]!.text).toBe("code_map_path: AuthModule → Database ✓");
  });

  it("keeps Shell command labels", () => {
    appendSdkMessage(
      JOB,
      toolCall("Shell", { command: "git status" }, "completed"),
    );
    const { lines } = getJobProgress(JOB);
    expect(lines[0]!.text).toBe("Shell: git status ✓");
  });

  it("captures createPlan full body and mirrors to Process", () => {
    const plan = [
      "## Mục tiêu",
      "Sửa recalc used",
      "## Bước",
      "1. Đọc service",
      "2. Gắn off_hours",
    ].join("\n");
    appendSdkMessage(
      JOB,
      toolCall("createPlan", { plan }, "completed"),
    );
    expect(getJobCapturedPlan(JOB)).toBe(plan);
    const { lines } = getJobProgress(JOB);
    const assistant = lines.find((l) => l.kind === "assistant");
    expect(assistant?.text).toContain("Sửa recalc used");
    expect(assistant?.text).toContain("off_hours");
    const tool = lines.find((l) => l.kind === "tool");
    expect(tool?.text).toMatch(/^createPlan:/);
  });
});
