import { describe, expect, it } from "vitest";
import { isNonFastForwardPushError } from "../prep.js";

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
