import { describe, expect, it } from "vitest";
import {
  BA_GITLAB_INTERACTION_ENABLED,
  baGitlabBoundaryInstructions,
} from "../baChat.js";

describe("baGitlabBoundaryInstructions", () => {
  it("forbids GitLab issue and comment actions while the gate is off", () => {
    expect(BA_GITLAB_INTERACTION_ENABLED).toBe(false);
    const text = baGitlabBoundaryInstructions();
    expect(text).toMatch(/GitLab \(TẠM CẤM\)/);
    expect(text).toMatch(/không tạo\/sửa issue/);
    expect(text).toMatch(/không comment/);
    expect(text).toMatch(/từ chối/);
    expect(text).not.toMatch(/gợi ý tạo ticket cho Dev/);
  });
});
