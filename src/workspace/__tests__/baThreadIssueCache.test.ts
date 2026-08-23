import { describe, expect, it } from "vitest";
import {
  hashBaThreadMessages,
  isBaThreadIssueDraftCacheValid,
  type BaMessage,
  type BaThread,
  type BaThreadIssueDraftCache,
} from "../../workspace/baStore.js";

function msg(
  partial: Partial<BaMessage> & Pick<BaMessage, "id" | "role" | "content">,
): BaMessage {
  return {
    threadId: "bat_test",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...partial,
  };
}

function thread(version = 0): BaThread {
  return {
    id: "bat_test",
    userId: "u1",
    baProjectId: "bap_1",
    title: "Test",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    issueDraftVersion: version,
  };
}

function cache(version: number): BaThreadIssueDraftCache {
  return {
    version,
    cachedAt: "2026-01-01T00:00:00.000Z",
    draft: {
      title: "Issue title",
      description: "Desc",
      labels: [],
      acceptanceCriteria: [],
    },
  };
}

describe("hashBaThreadMessages", () => {
  it("is stable for the same messages", () => {
    const messages = [
      msg({ id: "m1", role: "user", content: "Hello" }),
      msg({ id: "m2", role: "assistant", content: "Hi there" }),
    ];
    expect(hashBaThreadMessages(messages)).toBe(hashBaThreadMessages(messages));
  });

  it("changes when message content changes", () => {
    const a = [msg({ id: "m1", role: "user", content: "A" })];
    const b = [msg({ id: "m1", role: "user", content: "B" })];
    expect(hashBaThreadMessages(a)).not.toBe(hashBaThreadMessages(b));
  });

  it("changes when a new message is added", () => {
    const one = [msg({ id: "m1", role: "user", content: "A" })];
    const two = [
      ...one,
      msg({ id: "m2", role: "assistant", content: "Reply" }),
    ];
    expect(hashBaThreadMessages(one)).not.toBe(hashBaThreadMessages(two));
  });

  it("ignores empty-content messages", () => {
    const withEmpty = [
      msg({ id: "m1", role: "user", content: "A" }),
      msg({ id: "m2", role: "assistant", content: "   " }),
    ];
    const without = [msg({ id: "m1", role: "user", content: "A" })];
    expect(hashBaThreadMessages(withEmpty)).toBe(hashBaThreadMessages(without));
  });
});

describe("isBaThreadIssueDraftCacheValid", () => {
  it("hits when cache version matches thread version", () => {
    expect(isBaThreadIssueDraftCacheValid(thread(3), cache(3))).toBe(true);
  });

  it("misses when version differs", () => {
    expect(isBaThreadIssueDraftCacheValid(thread(4), cache(3))).toBe(false);
  });

  it("misses when cache is missing", () => {
    expect(isBaThreadIssueDraftCacheValid(thread(1), undefined)).toBe(false);
  });

  it("misses when draft title is empty", () => {
    const bad: BaThreadIssueDraftCache = {
      ...cache(1),
      draft: { ...cache(1).draft, title: "  " },
    };
    expect(isBaThreadIssueDraftCacheValid(thread(1), bad)).toBe(false);
  });

  it("treats missing thread version as 0", () => {
    const t = thread();
    delete t.issueDraftVersion;
    expect(isBaThreadIssueDraftCacheValid(t, cache(0))).toBe(true);
  });
});
