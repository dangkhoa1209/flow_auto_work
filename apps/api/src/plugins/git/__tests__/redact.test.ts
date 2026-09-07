import { describe, expect, it } from "vitest";
import {
  redactGitCredentials,
  redactGitError,
  safeErrorMessage,
} from "../redact.js";

/** Synthetic fixture — never paste a real github_pat_ / ghp_ into tests (push protection). */
const FAKE_GITHUB_PAT = ["github_pat_", "00TEST00TEST00TEST00TEST_", "0".repeat(60)].join("");
const FAKE_GHP = ["ghp_", "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "123456"].join("");

describe("redactGitCredentials", () => {
  it("redacts x-access-token URL in Node execFile Command failed message", () => {
    const raw =
      `Command failed: git push https://x-access-token:${FAKE_GITHUB_PAT}@github.com/example/repo.git HEAD:refs/heads/feat/demo\n` +
      "fatal: unable to access 'https://github.com/example/repo.git/': Couldn't connect to server";
    const out = redactGitCredentials(raw);
    expect(out).toContain("x-access-token:***@github.com/");
    expect(out).not.toMatch(/github_pat_[A-Za-z0-9]{10,}/);
    expect(out).toContain("Couldn't connect to server");
  });

  it("redacts oauth2 and glpat tokens", () => {
    const out = redactGitCredentials(
      "git push https://oauth2:glpat-abcDEF123_456@gitlab.com/g/r.git",
    );
    expect(out).toContain("oauth2:***@");
    expect(out).not.toContain("glpat-abc");
  });
});

describe("safeErrorMessage / redactGitError", () => {
  it("safeErrorMessage redacts Error.message for /work Chat lỗi", () => {
    const err = new Error(
      `Command failed: git push https://x-access-token:${FAKE_GHP}@github.com/o/r.git HEAD:refs/heads/main`,
    );
    const msg = safeErrorMessage(err);
    expect(msg).toContain("x-access-token:***@");
    expect(msg).not.toMatch(/ghp_[A-Za-z0-9]+/);
  });

  it("redactGitError mutates message and cmd", () => {
    const err = new Error(
      "Command failed: git push https://x-access-token:token123@github.com/o/r.git",
    ) as Error & { cmd?: string };
    err.cmd = "git push https://x-access-token:token123@github.com/o/r.git";
    redactGitError(err);
    expect(err.message).toContain("x-access-token:***@");
    expect(err.cmd).toContain("x-access-token:***@");
    expect(err.message).not.toContain("token123");
  });
});
