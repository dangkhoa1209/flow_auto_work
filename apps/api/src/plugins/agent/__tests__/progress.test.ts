import { afterEach, describe, expect, it, vi } from "vitest";
import { subscribeRealtime } from "../../realtime/hub.js";
import {
  appendJobProgress,
  clearJobProgress,
  getJobProgress,
  PROGRESS_PUBLISH_MS,
} from "../progress.js";

const JOB = "progress-format-job";

afterEach(() => {
  clearJobProgress(JOB);
  vi.useRealTimers();
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
