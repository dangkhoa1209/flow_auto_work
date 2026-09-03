import { describe, expect, it } from "vitest";
import { titleFromWorkRequest } from "../sessionTitle.js";

describe("titleFromWorkRequest", () => {
  it("uses the first non-empty line", () => {
    expect(titleFromWorkRequest("  \nFix login timeout\nmore")).toBe(
      "Fix login timeout",
    );
  });

  it("clips long titles", () => {
    const t = titleFromWorkRequest("a".repeat(80));
    expect(t.length).toBe(72);
    expect(t.endsWith("…")).toBe(true);
  });

  it("falls back when empty", () => {
    expect(titleFromWorkRequest("  \n")).toBe("Session");
  });
});
