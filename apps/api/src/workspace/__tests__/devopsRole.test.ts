import { describe, expect, it } from "vitest";
import {
  canAccessBa,
  canAccessDevops,
  isDevopsAudience,
  normalizeUserRoles,
  primaryHomePath,
} from "../types.js";

describe("devops role helpers", () => {
  it("normalizes devops in roles", () => {
    expect(normalizeUserRoles(["devops", "dev"])).toEqual(["devops", "dev"]);
  });

  it("defaults legacy empty roles to dev", () => {
    expect(normalizeUserRoles([])).toEqual(["dev"]);
    expect(normalizeUserRoles(null)).toEqual(["dev"]);
  });

  it("lets admin, devops, and dev open the console", () => {
    expect(canAccessDevops(["admin"])).toBe(true);
    expect(canAccessDevops(["devops"])).toBe(true);
    expect(canAccessDevops(["dev"])).toBe(true);
  });

  it("lets devops open project chat", () => {
    expect(canAccessBa(["devops"])).toBe(true);
    expect(canAccessBa(["ba"])).toBe(true);
    expect(canAccessBa(["qc"])).toBe(true);
  });

  it("sends devops-only users to /devops", () => {
    expect(isDevopsAudience(["devops"])).toBe(true);
    expect(isDevopsAudience(["devops", "dev"])).toBe(false);
    expect(primaryHomePath(["devops"])).toBe("/devops");
    expect(primaryHomePath(["devops", "dev"])).toBe("/work");
  });
});
