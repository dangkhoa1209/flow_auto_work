import { describe, expect, it } from "vitest";
import {
  canAccessDevops,
  isDevopsAudience,
  normalizeUserRoles,
  primaryHomePath,
} from "../types.js";

describe("devops role helpers", () => {
  it("normalizes devops in roles", () => {
    expect(normalizeUserRoles(["devops", "dev"])).toEqual(["devops", "dev"]);
  });

  it("lets admin and devops open the console", () => {
    expect(canAccessDevops(["admin"])).toBe(true);
    expect(canAccessDevops(["devops"])).toBe(true);
    expect(canAccessDevops(["dev"])).toBe(false);
  });

  it("sends devops-only users to /devops", () => {
    expect(isDevopsAudience(["devops"])).toBe(true);
    expect(isDevopsAudience(["devops", "dev"])).toBe(false);
    expect(primaryHomePath(["devops"])).toBe("/devops");
    expect(primaryHomePath(["devops", "dev"])).toBe("/work");
  });
});
