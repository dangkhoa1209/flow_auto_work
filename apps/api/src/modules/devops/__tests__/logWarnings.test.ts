import { describe, expect, it } from "vitest";
import {
  extractLogSection,
  findBuildLogKeywordHits,
  resolveBuildStatusFromLogKeywords,
} from "../logWarnings.js";

describe("extractLogSection", () => {
  it("takes contiguous lines around the match until blank boundaries", () => {
    const lines = [
      "ok step",
      "",
      "rsync: failed to open foo",
      "rsync error: some files were not transferred (code 23)",
      "more detail",
      "",
      "cleanup",
    ];
    const section = extractLogSection(lines, [3]);
    expect(section).toBe(
      [
        "rsync: failed to open foo",
        "rsync error: some files were not transferred (code 23)",
        "more detail",
      ].join("\n"),
    );
  });
});

describe("findBuildLogKeywordHits", () => {
  it("detects rsync error and returns the section", () => {
    const lines = [
      "building…",
      "rsync error: unexplained error (code 255) at main.c(1330)",
      "done",
    ];
    const hits = findBuildLogKeywordHits(lines);
    expect(hits).toHaveLength(1);
    expect(hits[0].keywordId).toBe("rsync_error");
    expect(hits[0].section).toContain("rsync error");
  });

  it("returns empty when keyword is absent", () => {
    expect(findBuildLogKeywordHits(["all good", "exit 0"])).toEqual([]);
  });
});

describe("resolveBuildStatusFromLogKeywords", () => {
  it("forces success → failed and sets warningMessage", () => {
    const res = resolveBuildStatusFromLogKeywords("success", [
      "deploying",
      "rsync error: timeout",
    ]);
    expect(res.status).toBe("failed");
    expect(res.forcedFail).toBe(true);
    expect(res.errorMessage).toMatch(/rsync error/i);
    expect(res.warningMessage).toContain("rsync error: timeout");
  });

  it("keeps failed status and enriches errorMessage", () => {
    const res = resolveBuildStatusFromLogKeywords(
      "failed",
      ["rsync error: code 23"],
      "Exit code 1",
    );
    expect(res.status).toBe("failed");
    expect(res.forcedFail).toBe(false);
    expect(res.errorMessage).toContain("Exit code 1");
    expect(res.errorMessage).toMatch(/Detected rsync error/i);
    expect(res.warningMessage).toContain("rsync error: code 23");
  });

  it("does not change cancelled/timeout status", () => {
    const cancelled = resolveBuildStatusFromLogKeywords("cancelled", [
      "rsync error: x",
    ]);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.warningMessage).toContain("rsync error");

    const timeout = resolveBuildStatusFromLogKeywords("timeout", [
      "rsync error: x",
    ]);
    expect(timeout.status).toBe("timeout");
  });
});
