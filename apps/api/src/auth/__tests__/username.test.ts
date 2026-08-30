import { describe, expect, it } from "vitest";
import {
  isValidAuthUsername,
  normalizeAuthUsername,
} from "../username.js";

describe("normalizeAuthUsername", () => {
  it("strips leading @ only", () => {
    expect(normalizeAuthUsername("@khoa")).toBe("khoa");
    expect(normalizeAuthUsername("  user@x.com  ")).toBe("user@x.com");
  });
});

describe("isValidAuthUsername", () => {
  it("accepts legacy usernames", () => {
    expect(isValidAuthUsername("khoadev")).toBe(true);
    expect(isValidAuthUsername("user.name_1")).toBe(true);
  });

  it("accepts email addresses", () => {
    expect(isValidAuthUsername("ba@company.com")).toBe(true);
    expect(isValidAuthUsername("user.name+tag@example.co.uk")).toBe(true);
  });

  it("rejects invalid values", () => {
    expect(isValidAuthUsername("ab")).toBe(false);
    expect(isValidAuthUsername("bad email")).toBe(false);
    expect(isValidAuthUsername("@")).toBe(false);
  });
});
