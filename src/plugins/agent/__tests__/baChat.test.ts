import { describe, expect, it } from "vitest";
import {
  BA_GITLAB_INTERACTION_ENABLED,
  baAnalysisModeInstructions,
  baGitlabBoundaryInstructions,
  baIntentTriageGate,
  baReadOnlyWorkspaceRules,
  baSpecFormatInstructions,
} from "../baChat.js";
import {
  extractBaIssueRefs,
  formatBaIssueSnapshot,
} from "../../gitlab/ba-issue-read.js";

describe("baReadOnlyWorkspaceRules", () => {
  it("forbids file writes and destructive shell/git", () => {
    const text = baReadOnlyWorkspaceRules({ mainBranch: "main" });
    expect(text).toMatch(/Cấm ghi file/);
    expect(text).toMatch(/Deliverable chỉ trong chat/);
    expect(text).toMatch(/Không.*Write/);
    expect(text).toMatch(/Cấm sửa code/);
    expect(text).toMatch(/branch \*\*main\*\*/);
    expect(text).toMatch(/Cấm.*rm/);
  });
});

describe("baSpecFormatInstructions", () => {
  it("separates input (1–2) from BA analysis (3)", () => {
    const text = baSpecFormatInstructions();
    expect(text).toMatch(/Phân vai rõ ràng/);
    expect(text).toMatch(/đầu vào/);
    expect(text).toMatch(/kết quả phân tích của BA/);
    expect(text).toMatch(/YC gốc/);
    expect(text).toMatch(/deliverable chính/);
    expect(text).toMatch(/không pad mục trống/i);
  });
});

describe("baAnalysisModeInstructions", () => {
  it("uses spec format without screen mockups", () => {
    const text = baAnalysisModeInstructions();
    expect(text).toMatch(/format spec|Gợi ý trình bày/);
    expect(text).toMatch(/Không.*mockup/);
    expect(text).toMatch(/Mức tối thiểu/);
    expect(text).toMatch(/Yêu cầu khách hàng/);
    expect(text).toMatch(/không.*tạo file/);
  });
});

describe("baGitlabBoundaryInstructions", () => {
  it("forbids GitLab writes in every BA mode, allows read via pasted link/id", () => {
    expect(BA_GITLAB_INTERACTION_ENABLED).toBe(false);
    const text = baGitlabBoundaryInstructions();
    expect(text).toMatch(/GitLab ghi \(TẠM CẤM, cả BA mode\)/);
    expect(text).toMatch(/không tạo\/sửa issue/);
    expect(text).toMatch(/không comment/);
    expect(text).toMatch(/GitLab đọc \(được phép\)/);
    expect(text).toMatch(/link issue/);
    expect(text).not.toMatch(/gợi ý tạo ticket cho Dev/);
  });
});

describe("baIntentTriageGate", () => {
  it("requires triage before codebase scan and BA templates", () => {
    const text = baIntentTriageGate();
    expect(text).toMatch(/INTENT TRIAGE & SANITY CHECK/);
    expect(text).toMatch(/GREETING \/ CASUAL \/ NOISE/);
    expect(text).toMatch(/INSUFFICIENT CONTEXT/);
    expect(text).toMatch(/FULL BA PIPELINE/);
    expect(text).toMatch(/KHÔNG scan codebase/);
  });
});

describe("extractBaIssueRefs", () => {
  const project = "group/app";

  it("parses #id, issue N, and GitLab URLs including work items", () => {
    const text = [
      "xem #42 giúp mình",
      "https://gitlab.com/acme/app/-/issues/99",
      "https://git.internal/team/svc/-/work_items/7",
    ].join("\n");
    const refs = extractBaIssueRefs(text, project);
    expect(refs).toEqual([
      { iid: 99, gitlabPath: "acme/app" },
      { iid: 7, gitlabPath: "team/svc" },
      { iid: 42, gitlabPath: "group/app" },
    ]);
  });

  it("parses issue/task/ticket N against the current project", () => {
    expect(extractBaIssueRefs("phân tích issue 12", project)).toEqual([
      { iid: 12, gitlabPath: "group/app" },
    ]);
    expect(extractBaIssueRefs("xem task 8", project)[0]?.iid).toBe(8);
    expect(extractBaIssueRefs("đọc id 15", project)[0]?.iid).toBe(15);
  });

  it("lets a pasted URL override the default project path for the same iid", () => {
    const text = "#42 https://gitlab.com/other/repo/-/issues/42";
    expect(extractBaIssueRefs(text, project)).toEqual([
      { iid: 42, gitlabPath: "other/repo" },
    ]);
  });

  it("caps at 3 unique issues", () => {
    const refs = extractBaIssueRefs("#1 #2 #3 #4", project);
    expect(refs.map((r) => r.iid)).toEqual([1, 2, 3]);
  });
});

describe("formatBaIssueSnapshot", () => {
  it("renders title, description, and comments", () => {
    const body = formatBaIssueSnapshot({
      iid: 8,
      title: "Sửa filter",
      state: "opened",
      url: "https://gitlab.com/g/a/-/issues/8",
      labels: ["ba"],
      assignees: ["minh"],
      description: "Lọc theo phòng ban",
      notes: [
        { author: "ba", createdAt: "2026-08-01T00:00:00Z", body: "ok" },
      ],
    });
    expect(body).toContain("#8 — Sửa filter");
    expect(body).toContain("Lọc theo phòng ban");
    expect(body).toContain("@ba (2026-08-01): ok");
  });
});
