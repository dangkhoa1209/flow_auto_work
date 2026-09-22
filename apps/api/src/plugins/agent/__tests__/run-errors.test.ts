import { describe, expect, it, vi } from "vitest";
import {
  errorFromCursorRunStatus,
  formatCursorAgentFailure,
  isTransientCursorTransportError,
  nextWithStreamIdleTimeout,
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
      expect(String(err)).toMatch(/timed out after .+ with no stream event/i);
      expect(isTransientCursorTransportError(err)).toBe(true);
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