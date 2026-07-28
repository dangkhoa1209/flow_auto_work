import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractJsonPath, maskSecrets } from "../plugins/login/json-path.js";
import { parseQaOutcome } from "../plugins/agent/prompt.js";
import { buildQaIssueMarkdown } from "../plugins/issue/markdown.js";

describe("extractJsonPath", () => {
  it("reads nested token path", () => {
    assert.equal(
      extractJsonPath(
        { data: { accessToken: "abc.def.ghi" } },
        "data.accessToken",
      ),
      "abc.def.ghi",
    );
  });

  it("returns null when missing", () => {
    assert.equal(extractJsonPath({ data: {} }, "data.accessToken"), null);
  });
});

describe("parseQaOutcome", () => {
  it("parses QA_DONE block", () => {
    const text = [
      "working…",
      "<<<QA_DONE>>>",
      JSON.stringify({
        summary: "Bug on checkout",
        draftTitle: "Checkout 500",
        actionLog: ["[Step 1: Click buy]"],
        consoleErrors: [{ message: "TypeError" }],
        networkFailures: [
          { url: "/api/v1/checkout", method: "POST", status: 500 },
        ],
      }),
      "<<<END_QA_DONE>>>",
    ].join("\n");
    const out = parseQaOutcome(text);
    assert.equal(out.kind, "done");
    assert.equal(out.summary, "Bug on checkout");
    assert.equal(out.networkFailures?.[0]?.status, 500);
  });

  it("parses QA_NEED_HELP block", () => {
    const text = `<<<QA_NEED_HELP>>>
{"helpMessage":"selector not found","actionLog":["[Step 1: open]"]}
<<<END_QA_NEED_HELP>>>`;
    const out = parseQaOutcome(text);
    assert.equal(out.kind, "need_help");
    assert.ok(out.helpMessage?.includes("selector"));
  });
});

describe("buildQaIssueMarkdown", () => {
  it("includes primary failed request and screenshot", () => {
    const md = buildQaIssueMarkdown({
      qa: {
        targetUrl: "https://staging.example.com/cart",
        presetId: "p1",
        presetRole: "VIP",
        testcase: "Checkout fails",
        consoleErrors: [{ message: "TypeError: x", stack: "at a.ts:1" }],
        networkFailures: [
          {
            url: "https://staging-api/checkout",
            method: "POST",
            status: 500,
            responseBody: '{"code":"ERR"}',
          },
        ],
      },
      screenshotMarkdownUrl: "https://gitlab/uploads/shot.png",
      functionalSummary: "Cannot checkout",
    });
    assert.ok(md.includes("## Functional Summary"));
    assert.ok(md.includes("POST https://staging-api/checkout"));
    assert.ok(md.includes("VIP"));
    assert.ok(md.includes("![Bug Screenshot]"));
  });
});

describe("maskSecrets", () => {
  it("redacts password fields", () => {
    const out = maskSecrets("password=secret123 token=abc");
    assert.ok(!out.includes("secret123"));
    assert.ok(out.includes("[REDACTED]"));
  });
});
