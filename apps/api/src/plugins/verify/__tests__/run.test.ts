import { describe, expect, it } from "vitest";
import { runVerifyCommand } from "../run.js";

describe("runVerifyCommand", () => {
  it("returns ok=true for passing command", async () => {
    const res = await runVerifyCommand(process.cwd(), "echo verify-pass");
    expect(res.ok).toBe(true);
    expect(res.exitCode).toBe(0);
    expect(res.output).toContain("verify-pass");
  });

  it("returns ok=false + output for failing command", async () => {
    const res = await runVerifyCommand(
      process.cwd(),
      "echo boom-error >&2; exit 3",
    );
    expect(res.ok).toBe(false);
    expect(res.exitCode).toBe(3);
    expect(res.output).toContain("boom-error");
  });
});
