import { describe, expect, it } from "vitest";
import {
  clarifyGitRemoteError,
  isNonFastForwardPushError,
  shouldAbortMergeForWorkBranch,
} from "../prep.js";

describe("isNonFastForwardPushError", () => {
  it("detects classic non-fast-forward reject", () => {
    const msg =
      "Command failed: git push https://gitlab.com/kiemnv/aihr_v3.git HEAD:refs/heads/project/ykk\n" +
      "! [rejected]              HEAD -> project/ykk (non-fast-forward)\n" +
      "error: failed to push some refs to 'https://gitlab.com/kiemnv/aihr_v3.git'\n" +
      "hint: Updates were rejected because the tip of your current branch is behind";
    expect(isNonFastForwardPushError(new Error(msg))).toBe(true);
  });

  it("detects fetch-first reject", () => {
    expect(
      isNonFastForwardPushError(
        new Error("! [rejected] HEAD -> feat/x (fetch first)"),
      ),
    ).toBe(true);
  });

  it("ignores bare 'fetch first' without rejected", () => {
    expect(
      isNonFastForwardPushError(
        new Error("hint: please fetch first before continuing"),
      ),
    ).toBe(false);
  });

  it("ignores network / auth style failures", () => {
    expect(
      isNonFastForwardPushError(
        new Error("fatal: unable to access: Couldn't connect to server"),
      ),
    ).toBe(false);
    expect(
      isNonFastForwardPushError(
        new Error("remote: HTTP Basic: Access denied"),
      ),
    ).toBe(false);
  });
});

describe("shouldAbortMergeForWorkBranch", () => {
  it("aborts when MERGE_HEAD is on base but job expects work branch", () => {
    expect(
      shouldAbortMergeForWorkBranch("main", "feat/khoa/feature"),
    ).toBe(true);
  });

  it("keeps open merge when already on the work branch", () => {
    expect(
      shouldAbortMergeForWorkBranch("feat/khoa/feature", "feat/khoa/feature"),
    ).toBe(false);
  });

  it("does not abort when desired work branch is unknown", () => {
    expect(shouldAbortMergeForWorkBranch("main", undefined)).toBe(false);
    expect(shouldAbortMergeForWorkBranch("main", "")).toBe(false);
  });
});

describe("clarifyGitRemoteError", () => {
  it("rewrites HTTP Basic access denied into PAT refresh hint", () => {
    const out = clarifyGitRemoteError(
      new Error(
        "remote: HTTP Basic: Access denied\nfatal: Authentication failed",
      ),
      "feat/x",
    );
    expect(out.message).toMatch(/Git authentication failed/);
    expect(out.message).toMatch(/Settings → Project/);
    expect(out.message).toMatch(/feat\/x/);
  });

  it("rewrites protected-branch rejects into policy hint", () => {
    const out = clarifyGitRemoteError(
      new Error(
        "remote: GitLab: You are not allowed to push code to protected branches on this project.",
      ),
      "project/ykk",
    );
    expect(out.message).toMatch(/Push rejected by remote policy/);
    expect(out.message).toMatch(/protected branch/);
    expect(out.message).toMatch(/Merge via MR/);
  });

  it("leaves non-fast-forward messages intact", () => {
    const msg =
      "! [rejected] HEAD -> feat/x (non-fast-forward)\nhint: tip of your current branch is behind";
    const out = clarifyGitRemoteError(new Error(msg), "feat/x");
    expect(out.message).toContain("non-fast-forward");
    expect(out.message).not.toMatch(/authentication failed/i);
    expect(out.message).not.toMatch(/remote policy/i);
  });
});
