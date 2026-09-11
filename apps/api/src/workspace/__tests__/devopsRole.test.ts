import { describe, expect, it } from "vitest";
import {
  canAccessBa,
  canAccessDevops,
  canAccessProjectChat,
  canAccessQc,
  canConfigureDevopsScripts,
  isBaAudience,
  isDevopsAudience,
  isQcAudience,
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

  it("lets only devops and admin configure scripts", () => {
    expect(canConfigureDevopsScripts(["devops"])).toBe(true);
    expect(canConfigureDevopsScripts(["admin"])).toBe(true);
    expect(canConfigureDevopsScripts(["dev"])).toBe(false);
    expect(canConfigureDevopsScripts(["devops", "dev"])).toBe(true);
  });

  it("splits BA and QC project chat surfaces", () => {
    expect(canAccessBa(["devops"])).toBe(true);
    expect(canAccessBa(["ba"])).toBe(true);
    expect(canAccessBa(["pd"])).toBe(true);
    expect(canAccessBa(["qc"])).toBe(false);
    expect(isBaAudience(["qc"])).toBe(false);
    expect(isBaAudience(["ba"])).toBe(true);

    expect(canAccessQc(["qc"])).toBe(true);
    expect(canAccessQc(["devops"])).toBe(true);
    expect(canAccessQc(["ba"])).toBe(false);
    expect(isQcAudience(["qc"])).toBe(true);
    expect(isQcAudience(["ba"])).toBe(false);

    expect(canAccessProjectChat(["qc"])).toBe(true);
    expect(canAccessProjectChat(["ba"])).toBe(true);
  });

  it("sends devops-only users to /devops", () => {
    expect(isDevopsAudience(["devops"])).toBe(true);
    expect(isDevopsAudience(["devops", "dev"])).toBe(false);
    expect(primaryHomePath(["devops"])).toBe("/devops");
    expect(primaryHomePath(["devops", "dev"])).toBe("/dev");
  });

  it("sends qc-only users to /qc and ba/pd to /ba", () => {
    expect(primaryHomePath(["qc"])).toBe("/qc");
    expect(primaryHomePath(["ba"])).toBe("/ba");
    expect(primaryHomePath(["pd"])).toBe("/ba");
  });
});
