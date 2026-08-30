import { describe, expect, it } from "vitest";
import { AppError } from "../../../utils/AppError.js";
import { writeBuildStdin } from "../runner.js";

describe("writeBuildStdin", () => {
  it("rejects when no job is running", () => {
    expect(() => writeBuildStdin("bld_missing", "hello")).toThrow(AppError);
    try {
      writeBuildStdin("bld_missing", "hello");
    } catch (err) {
      expect(err).toMatchObject({ status: 409, code: "build_not_running" });
    }
  });

  it("rejects oversized payloads", () => {
    try {
      writeBuildStdin("bld_missing", "x".repeat(5000));
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toMatchObject({ status: 400, code: "stdin_too_long" });
    }
  });
});
