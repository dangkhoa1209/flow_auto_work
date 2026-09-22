import { describe, expect, it, vi } from "vitest";
import {
  errorFromCursorRunStatus,
  formatCursorAgentFailure,
  isStreamStallError,
  isTransientCursorTransportError,
  nextWithStreamIdleTimeout,
  streamStallTimeoutError,
} from "../run.js";

describe("errorFromCursorRunStatus", () => {
  it("marks long opaque empty failures as transient with VI message", () => {
    const err = errorFromCursorRunStatus({
      id: "run-6327c629-f083-4395-9c0c-91a5c68bdf67",
      requestId: "fe2cae55-b857-415c-9d8f-58b131bd2add",
      durationMs: 876_733,
    });
    expect(isTransientCursorTransportError(err)).toBe(true);
    expect(err.message).toMatch(/Cursor cắt agent run/i);
    expect(err.message).toMatch(/15 phút|14 phút/);
    expect(err.message).toContain("req=fe2cae55");
    expect(err.message).not.toMatch(/^Agent run failed/);
  });

  it("marks short empty failures as connect/transient", () => {
    const err = errorFromCursorRunStatus({
      id: "run-short",
      durationMs: 3_200,
    });
    expect(isTransientCursorTransportError(err)).toBe(true);
    expect(err.message).toMatch(/Không kết nối được Cursor API/i);
  });

  it("does not mark clear permanent-looking result text as transient", () => {
    const err = errorFromCursorRunStatus({
      id: "run-x",
      durationMs: 12_000,
      result: "Model refused: policy violation on this prompt",
    });
    expect(isTransientCursorTransportError(err)).toBe(false);
    expect(err.message).toContain("policy violation");
  });

  it("marks transport-ish result text as transient", () => {
    const err = errorFromCursorRunStatus({
      id: "run-y",
      durationMs: 40_000,
      result: "ConnectError: Stream closed / ENHANCE_YOUR_CALM",
    });
    expect(isTransientCursorTransportError(err)).toBe(true);
  });
});

describe("formatCursorAgentFailure", () => {
  it("translates opaque Agent run failed English dump", () => {
    const msg = formatCursorAgentFailure(
      new Error(
        "Agent run failed (run-abc): req=xyz · 876733ms",
      ),
      "fallback",
    );
    expect(msg).toMatch(/Cursor cắt agent run/i);
  });

  it("keeps VI stream stall message", () => {
    const err = streamStallTimeoutError("idle", 120_000);
    const msg = formatCursorAgentFailure(err, "fallback");
    expect(msg).toMatch(/Cursor treo 120s không có stream event/i);
    expect(msg).toMatch(/tự thử lại/i);
  });

  it("translates legacy English stall timeout", () => {
    const msg = formatCursorAgentFailure(
      new Error(
        "Cursor timed out after 120s with no stream event (tool/agent stall)",
      ),
      "fallback",
    );
    expect(msg).toMatch(/treo|mất stream/i);
    expect(msg).toMatch(/Gửi\/Run lại|tự thử lại/i);
  });
});

describe("streamStallTimeoutError", () => {
  it("marks idle stall as transient with concrete VI cause", () => {
    const err = streamStallTimeoutError("idle", 120_000);
    expect(isTransientCursorTransportError(err)).toBe(true);
    expect(isStreamStallError(err)).toBe(true);
    expect(err.message).toMatch(/Glob\/Shell\/MCP/i);
  });

  it("marks first-event stall as transient", () => {
    const err = streamStallTimeoutError("first", 45_000);
    expect(isTransientCursorTransportError(err)).toBe(true);
    expect(isStreamStallError(err)).toBe(true);
    expect(err.message).toMatch(/event đầu sau 45s/i);
  });
});

describe("nextWithStreamIdleTimeout", () => {
  it("returns the next event when it arrives before idle timeout", async () => {
    const cancel = vi.fn();
    const result = await nextWithStreamIdleTimeout(
      async () => ({ done: false as const, value: { type: "assistant" } }),
      { idleTimeoutMs: 5_000, cancel },
    );
    expect(result).toEqual({ done: false, value: { type: "assistant" } });
    expect(cancel).not.toHaveBeenCalled();
  });

  it("cancels and throws transient stall error when idle", async () => {
    const cancel = vi.fn(async () => undefined);
    const onStall = vi.fn();
    const pending = nextWithStreamIdleTimeout(
      () => new Promise(() => undefined),
      { idleTimeoutMs: 40, cancel, onStall },
    );
    await expect(pending).rejects.toSatisfy((err: unknown) => {
      expect(isTransientCursorTransportError(err)).toBe(true);
      expect(isStreamStallError(err)).toBe(true);
      expect(String(err)).toMatch(/không có stream event/i);
      return true;
    });
    expect(onStall).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("disables idle watchdog when idleTimeoutMs <= 0", async () => {
    const cancel = vi.fn();
    const result = await nextWithStreamIdleTimeout(
      async () => ({ done: true as const, value: undefined }),
      { idleTimeoutMs: 0, cancel },
    );
    expect(result.done).toBe(true);
    expect(cancel).not.toHaveBeenCalled();
  });
});
