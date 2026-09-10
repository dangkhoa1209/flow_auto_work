import { describe, expect, it } from "vitest";
import {
  compactGraphifyQueryOutput,
  cpuUsagePercentFromProcStatSamples,
  formatWorkGraphifyPromptBlock,
  isGraphifyUpdateProcessArgs,
  parseProcStatCpuLine,
} from "../graphify.js";

describe("formatWorkGraphifyPromptBlock", () => {
  it("teaches the agent to query with a short locator, not the full task", () => {
    const block = formatWorkGraphifyPromptBlock({
      sourcePath: "/tmp/project/user/app/source",
    });
    expect(block).toMatch(/code_map_query/);
    expect(block).toMatch(/You choose the query/i);
    expect(block).toMatch(/Do not paste the whole GitLab issue/i);
    expect(block).toMatch(/graphify-out/);
    expect(block).not.toMatch(/INTENT = case 3/);
    expect(block).not.toMatch(/Likely files/);
  });
});

describe("isGraphifyUpdateProcessArgs", () => {
  it("detects update CLI and workers, ignores query-only", () => {
    expect(
      isGraphifyUpdateProcessArgs(
        "/root/.local/bin/graphify update /home/www/proj/source",
      ),
    ).toBe(true);
    expect(
      isGraphifyUpdateProcessArgs(
        "/root/.local/share/pipx/venvs/graphifyy/bin/python /root/.local/bin/graphify update /x",
      ),
    ).toBe(true);
    expect(
      isGraphifyUpdateProcessArgs(
        "graphify query --graph /tmp/graph.json foo",
      ),
    ).toBe(false);
    expect(isGraphifyUpdateProcessArgs("ps -eo args=")).toBe(false);
    expect(isGraphifyUpdateProcessArgs("node apps/api/dist/server.js")).toBe(
      false,
    );
  });
});

describe("host CPU skip helpers", () => {
  it("parses aggregate cpu line and computes busy percent", () => {
    const a = parseProcStatCpuLine(
      "cpu  100 0 100 800 0 0 0 0\ncpu0 50 0 50 400 0 0 0 0\n",
    );
    const b = parseProcStatCpuLine(
      "cpu  150 0 150 850 0 0 0 0\ncpu0 75 0 75 425 0 0 0 0\n",
    );
    expect(a).toEqual({ idle: 800, total: 1000 });
    expect(b).toEqual({ idle: 850, total: 1150 });
    // totalΔ=150, idleΔ=50 → busy = (1 - 50/150)*100 ≈ 66.67
    expect(cpuUsagePercentFromProcStatSamples(a!, b!)).toBeCloseTo(
      66.666,
      2,
    );
  });

  it("returns null when total did not advance", () => {
    const sample = { idle: 100, total: 200 };
    expect(cpuUsagePercentFromProcStatSamples(sample, sample)).toBeNull();
  });
});

describe("compactGraphifyQueryOutput", () => {
  const dump = `
[!] TRUNCATED: showing 40 of 1615 nodes (~1800-token budget).
NODE Case: Công tính BHXH [src=docs/modules/timekeeping/calculation/case-smui-day-maternity-leave.md loc=L1]
NODE CHANGES.md [src=public/js/ckeditor/CHANGES.md loc=L1]
NODE he() [src=public/js/app.js loc=L170103]
NODE isPlainObject() [src=public/js/app.js loc=L13764]
NODE QualityAppraisal.vue [src=resources/js/views/project/review/QualityAppraisal.vue loc=L1]
NODE rules [src=resources/js/views/timekeeping/setting/config-rules-attendance/Index.vue loc=L214]
NODE mongodbConnect() [src=node_app/connects/mongodb.js loc=L5]
NODE THAIDUONG.blade.php [src=resources/views/pdf/payroll/payslip/THAIDUONG.blade.php loc=None]
NODE cong-doan.md [src=public/api/psm/cong-doan.md loc=L1]
`;

  it("keeps app source and docs, drops webpack bundles and ckeditor", () => {
    const out = compactGraphifyQueryOutput(dump);
    expect(out).toContain("QualityAppraisal.vue");
    expect(out).toContain("config-rules-attendance/Index.vue");
    expect(out).toContain("node_app/connects/mongodb.js");
    expect(out).toContain("THAIDUONG.blade.php");
    expect(out).toContain("docs/modules/timekeeping/calculation/");
    expect(out).not.toMatch(/public\/js\/app\.js/);
    expect(out).not.toMatch(/CHANGES\.md/);
    expect(out).not.toMatch(/cong-doan\.md/);
    expect(out).not.toMatch(/TRUNCATED/);
  });

  it("returns null when only noise matched", () => {
    expect(
      compactGraphifyQueryOutput(
        "NODE he() [src=public/js/app.js loc=L1]\nNODE x [src=public/js/ckeditor/CHANGES.md]",
      ),
    ).toBeNull();
  });
});
