import { describe, expect, it } from "vitest";
import {
  errorFromCursorRunStatus,
  formatCursorAgentFailure,
  isTransientCursorTransportError,
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
