import type { IssueJob } from "../types.js";

export function commitMessageForIssue(issue: IssueJob): string {
  const title = issue.title.replace(/\s+/g, " ").trim();
  return `feat #${issue.issueIid} ${title}`;
}

export function buildWorkPrompt(issue: IssueJob, extra?: string): string {
  const commitMsg = commitMessageForIssue(issue);
  return `You are the auto-work agent for AiHR v3.

Follow AGENTS.md and .cursor/skills/aihr/SKILL.md in this repo.
Load docs for the relevant module/feature (max ~3 doc files) before changing code.
Do not touch .env, credentials, or secrets.
Do not force-push, do not amend commits already on remote, do not merge the MR.
Do NOT switch git branches. Stay on the branch that is already checked out.
Do NOT stage or commit these local WIP files (leave them unstaged; do not add to .gitignore):
- resources/js/composables/permission.js
- resources/js/directives/index.js

## GitLab issue
- IID: #${issue.issueIid}
- Title: ${issue.title}
- URL: ${issue.url}
- Labels: ${issue.labels.join(", ") || "(none)"}
- Action that triggered this run: ${issue.action}

## Description
${issue.description || "(empty)"}

## Required workflow
1. Investigate via docs, then write a short plan.
2. Implement on the CURRENT git branch only (do not checkout/create other branches). Keep the change scoped to this issue.
3. Commit exactly with this message format (one commit preferred):

   ${commitMsg}

4. You do NOT need to push or open the MR — the orchestrator will do that after you finish.
5. If requirements are ambiguous or you are not confident which approach to take, do NOT guess.
   End your final reply with EXACTLY this block (and nothing after it):

<<<NEED_CLARIFICATION>>>
Your specific question(s) for the human here.
<<<END_NEED_CLARIFICATION>>>

6. If you finished successfully, end with:

<<<DONE>>>
Short summary of what changed.
<<<END_DONE>>>

${extra ? `## Additional context from human (Teams)\n${extra}\n` : ""}`;
}

export function buildResumePrompt(answer: string, issue: IssueJob): string {
  const commitMsg = commitMessageForIssue(issue);
  return `The human answered your clarification via Teams:

---
${answer}
---

Continue the same workflow on the CURRENT branch (do not switch branches).
Implement if clear enough; otherwise ask again with the NEED_CLARIFICATION block.
When finished, commit with message:

${commitMsg}

Then use the DONE block. Do not push/MR yourself.`;
}

export function parseAgentOutcome(text: string): {
  kind: "done" | "need_clarification" | "unknown";
  question?: string;
  summary?: string;
} {
  const clarify = text.match(
    /<<<NEED_CLARIFICATION>>>\s*([\s\S]*?)\s*<<<END_NEED_CLARIFICATION>>>/,
  );
  if (clarify) {
    return { kind: "need_clarification", question: clarify[1].trim() };
  }

  const done = text.match(/<<<DONE>>>\s*([\s\S]*?)\s*<<<END_DONE>>>/);
  if (done) {
    return { kind: "done", summary: done[1].trim() };
  }

  const loose = text.match(/NEED_CLARIFICATION:\s*([\s\S]+)$/i);
  if (loose) {
    return { kind: "need_clarification", question: loose[1].trim() };
  }

  return { kind: "unknown", summary: text.trim().slice(-2000) };
}
