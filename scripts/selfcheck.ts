import assert from "node:assert/strict";
import { filterIssueHook } from "../src/gitlab/filter.js";
import { parseAgentOutcome } from "../src/agent/prompt.js";
import type { AppConfig } from "../src/config.js";

const config = {
  ALLOWED_PROJECT_PATH: "kiemnv/aihr_v3",
  GITLAB_ASSIGNEE_USERNAME: "dangkhoa",
  skipLabels: ["auto-work:skip", "wip-human"],
} as AppConfig;

const basePayload = {
  object_kind: "issue",
  project: { id: 1, path_with_namespace: "kiemnv/aihr_v3" },
  object_attributes: {
    id: 10,
    iid: 42,
    title: "Fix leave calc",
    description: "Details",
    action: "open",
    url: "https://gitlab.com/kiemnv/aihr_v3/-/issues/42",
  },
  assignees: [{ id: 7, username: "dangkhoa" }],
  labels: [],
};

{
  const r = filterIssueHook("Issue Hook", basePayload, config);
  assert.equal(r.accept, true);
}

{
  const r = filterIssueHook(
    "Issue Hook",
    {
      ...basePayload,
      assignees: [{ username: "someone-else" }],
    },
    config,
  );
  assert.equal(r.accept, false);
}

{
  const r = filterIssueHook(
    "Issue Hook",
    {
      ...basePayload,
      labels: [{ title: "auto-work:skip" }],
    },
    config,
  );
  assert.equal(r.accept, false);
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

console.log("selfcheck ok");
