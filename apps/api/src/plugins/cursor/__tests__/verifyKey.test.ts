import { describe, expect, it, vi } from "vitest";

const meMock = vi.fn();

vi.mock("@cursor/sdk", () => ({
  Cursor: {
    me: (...args: unknown[]) => meMock(...args),
  },
}));

describe("verifyCursorApiKey", () => {
  it("rejects invalid user api key with actionable message", async () => {
    meMock.mockRejectedValueOnce(new Error("Invalid User API Key"));
    const { verifyCursorApiKey } = await import("../verifyKey.js");
    await expect(verifyCursorApiKey("bad-key")).rejects.toThrow(/full secret/i);
  });

  it("passes when Cursor.me succeeds", async () => {
    meMock.mockResolvedValueOnce({});
    const { verifyCursorApiKey } = await import("../verifyKey.js");
    await expect(verifyCursorApiKey("good-key")).resolves.toBeUndefined();
  });
});
