import assert from "node:assert/strict";
import { extractIssueIids, stripMediaAndAttachments } from "../src/gitlab/linked-context.js";
import { buildWorkPrompt, parseAgentOutcome } from "../src/agent/prompt.js";

{
  const iids = extractIssueIids(
    "See #13425 and also https://gitlab.com/kiemnv/aihr_v3/-/work_items/13919 related to #13425",
    100,
  );
  assert.deepEqual(
    iids.sort((a, b) => a - b),
    [13425, 13919],
  );
}

{
  const stripped = stripMediaAndAttachments(`
Fix the filter.

![screenshot](/uploads/abc123/screen.png)
[report.pdf](/uploads/def456/report.pdf)
See #99 for API.

<img src="/uploads/x/y.jpg" />
https://cdn.example.com/a.webp
`);
  assert.doesNotMatch(stripped, /uploads\//i);
  assert.doesNotMatch(stripped, /\.png|\.pdf|\.webp|\.jpg/i);
  assert.match(stripped, /Fix the filter/);
  assert.match(stripped, /#99/);
}

{
  const parsed = parseAgentOutcome(
    "thinking...\n<<<NEED_CLARIFICATION>>>\nWhich tenant?\n<<<END_NEED_CLARIFICATION>>>",
  );
  assert.equal(parsed.kind, "need_clarification");
  assert.equal(parsed.question, "Which tenant?");
}

{
  const parsed = parseAgentOutcome(
    "done\n<<<DONE>>>\nFixed X\n<<<END_DONE>>>",
  );
  assert.equal(parsed.kind, "done");
  assert.equal(parsed.summary, "Fixed X");
}

{
  const prompt = buildWorkPrompt(
    {
      projectId: 1,
      projectPath: "kiemnv/aihr_v3",
      issueIid: 102,
      issueId: 102,
      title: "Big table",
      description: "Show all rows",
      labels: ["frontend"],
      url: "https://example/issues/102",
      action: "manual",
    },
    undefined,
    undefined,
    "Dùng virtual scrolling, không load 100k DOM nodes.",
  );
  assert.match(prompt, /DEV NOTES \(HIGHEST PRIORITY\)/);
  assert.match(prompt, /virtual scrolling/);
  assert.match(prompt, /BUSINESS REQUIREMENTS \(GITLAB ISSUE #102\)/);
  const techIdx = prompt.indexOf("DEV NOTES");
  const bizIdx = prompt.indexOf("BUSINESS REQUIREMENTS");
  assert.ok(techIdx >= 0 && bizIdx > techIdx);
}

console.log("selfcheck ok");
