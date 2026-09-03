import type { IssueJob } from "../../types.js";
import { stripMediaAndAttachments } from "../gitlab/linked-context.js";

export function commitMessageForIssue(issue: IssueJob): string {
  const title = issue.title.replace(/\s+/g, " ").trim();
  if (issue.issueIid <= 0 || issue.action === "adhoc") {
    return `hotfix: ${title}`;
  }
  return `feat #${issue.issueIid} ${title}`;
}

export function docsCommitMessageForIssue(issue: IssueJob): string {
  const title = issue.title.replace(/\s+/g, " ").trim();
  return `docs #${issue.issueIid} ${title}`;
}

/**
 * Instruct agent how to comment on GitLab when the human asks in chat.
 * Flow does **not** auto-comment after a code Run finishes (avoids spam);
 * Create MR / Merge also do not post issue comments. Empty for adhoc (no issue yet).
 */
export function gitlabCommentInstructions(issue: IssueJob): string {
  if (issue.issueIid <= 0 || issue.action === "adhoc") return "";
  return `
# COMMENT ON THIS GITLAB ISSUE (#${issue.issueIid})
When the human asks you to **comment / cmt / ghi chú / trả lời trên issue/task** (GitLab):

**DO NOT** dig MongoDB, decrypt secrets, git credential, browser cookies, Flow session files, Tailscale, or invent PATs.
**DO NOT** call the GitLab API yourself (curl / glab / scripts that need a token).

Instead, put the comment text in this block — **Flow Auto Work posts it for you** and adds an \`AI-Generated\` tag:

<<<GITLAB_COMMENT>>>
Nội dung comment (tiếng Việt trừ khi human yêu cầu khác)…
<<<END_GITLAB_COMMENT>>>

Rules:
- Only use GITLAB_COMMENT when the human **asked** to comment on the issue (or clearly wants the team notified on GitLab).
- Do **not** use GITLAB_COMMENT for routine “done coding” status — Flow does not auto-comment after Run, Create MR, or Merge.
- You may use **multiple** GITLAB_COMMENT blocks in one reply.
- You may combine with <<<DONE>>> / <<<NEED_CLARIFICATION>>> (comment blocks can appear before DONE).
- If you already asked the team on GitLab via GITLAB_COMMENT, prefer ending with <<<DONE>>> (short note). Only use NEED_CLARIFICATION when you need an answer **in the Flow UI** to continue coding this turn.
- Do not put secrets, tokens, or .env contents in the comment.
- Issue URL: ${issue.url || `(#${issue.issueIid})`}

`;
}

function sharedPreamble(issue: IssueJob, devNotes?: string): {
  notesBlock: string;
  description: string;
  notes: string;
} {
  const notes = devNotes?.trim() || "";
  const description =
    stripMediaAndAttachments(issue.description || "") || "(empty)";
  const notesBlock = notes
    ? `# DEV NOTES (HIGHEST PRIORITY)
You MUST strictly follow these technical directions before referring to the business requirements:
> ${notes.split("\n").join("\n> ")}

`
    : "";
  return { notesBlock, description, notes };
}

/** Format UI chat into a prompt block for Run. */
export function formatChatContextForRun(
  messages: Array<{ role: string; kind?: string; body: string; createdAt?: string }>,
  opts?: { limit?: number },
): string {
  const limit = opts?.limit ?? 40;
  const rows = (messages || [])
    .filter((m) => m.body?.trim())
    .filter((m) => !m.kind || m.kind === "qa" || m.kind === "clarify" || m.kind === "note")
    .slice(-limit);
  if (!rows.length) return "";

  const lines = rows.map((m) => {
    const who =
      m.role === "user" ? "Human" : m.role === "agent" ? "Assistant" : "System";
    const kind = m.kind ? `/${m.kind}` : "";
    return `### ${who}${kind}\n${m.body.trim()}`;
  });

  return `# UI CHAT REQUESTS (HIGHEST PRIORITY FOR THIS RUN)
The human already asked / replied in the Flow Auto Work chat.
Treat the **latest Human messages** as the active instructions for this run (e.g. connect DB, seed NV, run queue, verify).
Do the work end-to-end when they asked you to execute — this is a full Run, not Q&A mode.

${lines.join("\n\n")}
`;
}

/**
 * Shared “how to load project conventions” — AGENTS.md first, then rules/skills/docs
 * that exist in the checkout (not hard-coded to one product).
 */
function projectConventionsBlock(opts?: { forDocsPhase?: boolean }): string {
  const docsHint = opts?.forDocsPhase
    ? `
Project knowledge (when present — adapt to this repo’s layout):
- **Feature / product docs**: often under \`docs/\` (hub README → module → feature). Prefer \`.md\` / \`.mdc\`.
- **Rules**: \`.cursor/rules/**/*.mdc\` — conventions for this codebase.
- Templates / shared docs if the tree has them (e.g. \`docs/_templates/\`, \`docs/shared/\`).
Do **not** invent a fixed product-specific docs tree if this repo uses a different layout — follow what \`AGENTS.md\` and the docs hub describe.
`
    : `
Also load (only what exists and is relevant):
- \`.cursor/skills/**/SKILL.md\` if the project ships skills for this workflow
- Relevant \`.cursor/rules/**/*.mdc\` (project, docs-loading, domain)
- Feature/product docs under \`docs/\` (or paths named in \`AGENTS.md\`) for modules you touch — keep the set small (~3)
`;

  return `# PROJECT CONVENTIONS (MANDATORY)
This checkout may be **any** customer/product repo — follow **this** repo’s conventions, not a hard-coded product stack.

**Read first:** \`AGENTS.md\` at the repo root (if missing, say so and use \`.cursor/rules\` + code exploration).
${docsHint}
Obey those sources. Do not invent patterns that contradict them.
`;
}

/**
 * Phase A: read/update feature docs (paths from AGENTS.md / docs hub — NOT per-issue files).
 */
export function buildDocsPhasePrompt(
  issue: IssueJob,
  linkedContext?: string,
  devNotes?: string,
  opts?: {
    chatContext?: string;
    contextQualityBlock?: string;
    googleSheetsBlock?: string;
    figmaBlock?: string;
    /** WorkBench graphify map (sibling graphify-out). */
    graphifyBlock?: string;
  },
): string {
  const { notesBlock, description } = sharedPreamble(issue, devNotes);
  const chatBlock = opts?.chatContext?.trim()
    ? `${opts.chatContext.trim()}\n\n`
    : "";
  const qualityBlock = opts?.contextQualityBlock?.trim()
    ? `${opts.contextQualityBlock.trim()}\n\n`
    : "";
  const linkedBlock = linkedContext?.trim()
    ? `\n## Linked / related context\n${linkedContext.trim()}\n`
    : "";
  const sheetsBlock = opts?.googleSheetsBlock?.trim()
    ? `\n${opts.googleSheetsBlock.trim()}\n`
    : "";
  const figmaBlock = opts?.figmaBlock?.trim()
    ? `\n${opts.figmaBlock.trim()}\n`
    : "";

  return `# MISSION — DOCS PHASE ONLY (NO APP CODE)
You are preparing documentation for GitLab issue #${issue.issueIid} on the **current project checkout** BEFORE any implementation.

${projectConventionsBlock({ forDocsPhase: true })}
${opts?.graphifyBlock ? `${opts.graphifyBlock}\n\n` : ""}Ignore image/file attachments — text only.

${qualityBlock}${chatBlock}${notesBlock}# BUSINESS REQUIREMENTS (GITLAB ISSUE #${issue.issueIid})
Title: ${issue.title}
URL: ${issue.url}
Labels: ${issue.labels.join(", ") || "(none)"}

## Description
${description}
${linkedBlock}${sheetsBlock}${figmaBlock}

# HARD RULES (DOCS PHASE)
1. DO NOT modify application code (no app source outside docs, no migrations, no app config).
2. You MAY create/update docs under the project’s docs tree (usually \`docs/\`, \`.md\` or \`.mdc\` only). Do NOT edit \`.cursor/rules/\` in this phase unless DEV NOTES explicitly require it.
3. Find the matching **feature** docs: start from \`AGENTS.md\`, then the docs hub (e.g. \`docs/README.md\`) → module → feature. Skim relevant \`.cursor/rules/\` (e.g. docs-loading). Max ~5 feature docs + needed rules.
4. Update existing feature docs when they already cover this area. Create a new feature folder only if none fits — follow project templates if present and link from the module/hub README.
5. Do NOT create per-issue files like \`docs/.../issues/...\` or \`*-issue-123.md\`. Docs belong to the product feature, not the ticket.
6. Docs should cover (as appropriate for the feature):
   - Goal / behavior
   - Scope
   - Code map / API / DB / FE (as this stack uses)
   - Risks & assumptions for this task (short notes in the feature doc OK)
   - Short implement plan if needed — no app code yet
7. Do NOT \`git commit\`, \`git push\`, open/merge MRs, or switch branches. Stay on the current branch. Flow Auto Work will commit your file changes to GitLab via API after you finish.
8. When docs are ready, end with EXACTLY this block (paths = feature docs you created/updated; may include \`.md\` / \`.mdc\`):

<<<DOCS_READY>>>
ANALYZED: Vietnamese — what you analyzed (2–5 bullets or a short paragraph): issue scope, main behavior/flow, docs/rules read, notable assumptions or gaps. Not only a path list.
SUMMARY: Vietnamese (1–3 sentences): which feature docs you created/updated and the main points recorded.
DOCS:
- docs/modules/<module>/<feature>/README.md
- docs/modules/<module>/<feature>/overview.md
<<<END_DOCS_READY>>>

List every docs file you created or substantially updated under DOCS (use real paths for this repo).
Both ANALYZED and SUMMARY are required — Flow shows them in chat for the PM.
9. If blocked, use NEED_CLARIFICATION for the Flow Auto Work UI.
${gitlabCommentInstructions(issue)}`;
}

/**
 * Plan-first: Cursor plan mode — explore and write a plan, no app code.
 */
export function buildPlanPhasePrompt(
  issue: IssueJob,
  linkedContext?: string,
  devNotes?: string,
  opts?: {
    chatContext?: string;
    contextQualityBlock?: string;
    googleSheetsBlock?: string;
    figmaBlock?: string;
  },
): string {
  const { notesBlock, description } = sharedPreamble(issue, devNotes);
  const chatBlock = opts?.chatContext?.trim()
    ? `${opts.chatContext.trim()}\n\n`
    : "";
  const qualityBlock = opts?.contextQualityBlock?.trim()
    ? `${opts.contextQualityBlock.trim()}\n\n`
    : "";
  const linkedBlock = linkedContext?.trim()
    ? `\n## Linked / related context\n${linkedContext.trim()}\n`
    : "";
  const sheetsBlock = opts?.googleSheetsBlock?.trim()
    ? `\n${opts.googleSheetsBlock.trim()}\n`
    : "";
  const figmaBlock = opts?.figmaBlock?.trim()
    ? `\n${opts.figmaBlock.trim()}\n`
    : "";

  return `# MISSION — PLAN PHASE ONLY (NO CODE CHANGES)
You are planning work for GitLab issue #${issue.issueIid} on the **current project checkout**.
This run is Cursor **plan mode**: read/search the repo, then produce an implementation plan.
Do NOT edit, write, delete, or run shell that mutates files. Do NOT commit or push.

${projectConventionsBlock()}
Ignore image/file attachments — text only.

${qualityBlock}${chatBlock}${notesBlock}# BUSINESS REQUIREMENTS (GITLAB ISSUE #${issue.issueIid})
Title: ${issue.title}
URL: ${issue.url}
Labels: ${issue.labels.join(", ") || "(none)"}

## Description
${description}
${linkedBlock}${sheetsBlock}${figmaBlock}

# HARD RULES (PLAN PHASE)
1. Only read/search tools (\`read\`, \`grep\`, \`glob\`, \`ls\`, code map). No app code, no docs file writes.
2. Search the repo before guessing file paths.
3. Write the plan in Vietnamese (unless DEV NOTES say otherwise): mục tiêu, phạm vi, file/neo code, rủi ro, bước implement.
4. Batch questions; only use NEED_CLARIFICATION when truly blocked.
5. When the plan is ready, end with EXACTLY this block:

<<<PLAN_READY>>>
PLAN: Vietnamese — structured plan (goals, files, steps, risks).
<<<END_PLAN_READY>>>

Flow Auto Work will pause for the human to approve, then a later Run will implement in agent mode.
${gitlabCommentInstructions(issue)}`;
}

/** Clarify-budget hint so the agent batches questions instead of ping-ponging. */
function clarifyBudgetLine(roundsLeft?: number): string {
  if (roundsLeft == null) return "";
  if (roundsLeft <= 0) {
    return "You have NO clarification rounds left — do NOT use NEED_CLARIFICATION. Proceed with the safest reasonable interpretation and record every assumption under ASSUMPTIONS in the DONE block.";
  }
  if (roundsLeft === 1) {
    return "This is your LAST clarification round — if you ask, batch EVERY open question into this one block. After the answer you must finish with best-effort assumptions.";
  }
  return `You have ${roundsLeft} clarification rounds left for this job — batch questions, don't spend a round on a single small question.`;
}

export function buildWorkPrompt(
  issue: IssueJob,
  extra?: string,
  linkedContext?: string,
  devNotes?: string,
  opts?: {
    approvedDocsPaths?: string[];
    chatContext?: string;
    contextQualityBlock?: string;
    googleSheetsBlock?: string;
    figmaBlock?: string;
    /** How many NEED_CLARIFICATION rounds remain before the job hard-fails. */
    clarifyRoundsLeft?: number;
    /** WorkBench graphify map (sibling graphify-out). */
    graphifyBlock?: string;
  },
): string {
  const { notesBlock, description } = sharedPreamble(issue, devNotes);

  const chatBlock = opts?.chatContext?.trim()
    ? `${opts.chatContext.trim()}\n\n`
    : "";
  const qualityBlock = opts?.contextQualityBlock?.trim()
    ? `${opts.contextQualityBlock.trim()}\n\n`
    : "";

  const linkedBlock = linkedContext?.trim()
    ? `\n## Linked / related context\n${linkedContext.trim()}\n`
    : "";
  const sheetsBlock = opts?.googleSheetsBlock?.trim()
    ? `\n${opts.googleSheetsBlock.trim()}\n`
    : "";
  const figmaBlock = opts?.figmaBlock?.trim()
    ? `\n${opts.figmaBlock.trim()}\n`
    : "";

  const extraBlock = extra?.trim()
    ? `\n## Additional context from human (UI)\n${extra.trim()}\n`
    : "";

  const paths = (opts?.approvedDocsPaths ?? [])
    .map((p) => p.trim())
    .filter(Boolean);
  const docsGateBlock =
    paths.length > 0
      ? `
# APPROVED FEATURE DOCS (MUST FOLLOW)
PM approved these project docs (\`.md\` / \`.mdc\`). Read them fully and implement accordingly — still obey \`AGENTS.md\` and \`.cursor/rules/**/*.mdc\`:
${paths.map((p) => `- \`${p}\``).join("\n")}
Do not contradict these docs unless DEV NOTES or UI CHAT REQUESTS override a specific point.
`
      : "";

  return `# MISSION
You are an expert developer implementing a feature based on a GitLab issue for the **current project checkout** (any product — follow this repo’s own conventions).

${projectConventionsBlock()}
${opts?.graphifyBlock ? `${opts.graphifyBlock}\n\n` : ""}Load the relevant module/feature docs and applicable rules before changing code.
Do not touch .env, credentials, or secrets.
Do NOT \`git commit\`, \`git push\`, force-push, amend remote commits, or create/merge MRs.
Do NOT switch git branches. Stay on the branch that is already checked out.
Flow Auto Work will commit your file changes to GitLab via API (PAT identity) after you finish.

${qualityBlock}${chatBlock}${notesBlock}${docsGateBlock}# BUSINESS REQUIREMENTS (GITLAB ISSUE #${issue.issueIid})
Title: ${issue.title}
URL: ${issue.url}
Labels: ${issue.labels.join(", ") || "(none)"}
Action that triggered this run: ${issue.action}

## Description
${description}
${linkedBlock}${sheetsBlock}${figmaBlock}
Use linked/mentioned issues and comments above as additional requirements/context. Prefer the primary issue (#${issue.issueIid}) scope; do not expand work into unrelated linked tickets unless required.
Ignore image/file attachments — only use text. Do not try to download or open media.

# HANDLING AMBIGUITY & MISSING INFO (resolve gaps in THIS order)
Real tickets are often incomplete. When something is unclear or missing:
1. **SELF-RESOLVE first.** Call \`code_map_query\` when that tool is attached, then search the repo, feature docs, and the linked issues/comments above. Most "missing" info (file paths, existing patterns, field names, similar screens) is discoverable in the codebase — never ask the human for something the code can answer.
2. **SAFE ASSUMPTION.** If the gap is minor and one interpretation is clearly standard for this codebase (naming, placement, UI copy, default sort/validation style), proceed — but record it and report it under \`ASSUMPTIONS:\` in the DONE block.
   NEVER assume on: deleting/migrating data, permissions/security, money or regulated formulas, external API contracts, or anything irreversible → those go to tier 3.
3. **ASK (last resort).** Only when the gap genuinely blocks a correct implementation. The human answers in the **Flow Auto Work UI**. End your reply with EXACTLY this block (nothing after it):

<<<NEED_CLARIFICATION>>>
Your question(s) for the human here (in Vietnamese).
<<<END_NEED_CLARIFICATION>>>

Question quality rules (strict):
- ${clarifyBudgetLine(opts?.clarifyRoundsLeft) || "Clarification rounds are limited — batch ALL open questions into ONE block."}
- Number each question; each must be answerable in one short sentence.
- Where possible give concrete options with your recommended default, e.g. \`1. Sort by? (A) newest created_at — recommended (B) name A→Z\` so the human can reply "1A, 2B".
- Say briefly what you already checked (files/docs/keywords searched) so the human doesn't repeat known info.
- Do NOT ask about things you can decide via tier 1/2.

# HARD / LARGE TASKS
If the task spans multiple modules, touches shared logic, or is risky:
- Write a short bullet plan BEFORE editing; follow it in small verifiable steps.
- Prefer the Task/subagent tools when helpful: \`explore\` (find files/patterns), \`code-reviewer\` (review your diff), \`test-writer\` (focused tests). You keep ownership of the final DONE.
- If mid-way you find the requirement contradicts codebase reality (screen/field/API named in the ticket doesn't exist or behaves differently), STOP and use NEED_CLARIFICATION **with evidence** (file + what you found) instead of forcing a wrong change.
- Do not silently drop scope; anything skipped goes under \`RISKS:\` in the DONE block.

# EXECUTION PLAN
1. Analyze the requirements but execute them EXACTLY as demanded in UI CHAT REQUESTS and DEV NOTES when present (those override conflicting business wording). Latest Human chat messages win for this run.
2. Investigate via **code_map_query** first (when the tool is attached), then docs (and the approved feature docs if listed above), then write a short plan.
3. Implement on the CURRENT git branch only (do not checkout/create other branches). Keep the change scoped to this issue.
4. Leave changes as modified files in the working tree — do NOT \`git commit\` or \`git push\`. The orchestrator commits to GitLab when you are done.
5. VERIFY before finishing: re-read your diff against the requirements; run the cheapest relevant check (lint/typecheck/build of touched files, or targeted test) when the repo supports it. Report what you verified under \`TESTED:\`.
6. When finished successfully, end with EXACTLY this block:

<<<DONE>>>
SUMMARY: Short Vietnamese summary (1–3 sentences): what you did / main changes.
ASSUMPTIONS: (only if any) tier-2 assumptions — one bullet each.
RISKS: (only if any) risks / cut scope / reviewer notes.
TESTED: how you verified (lint/build/test/manual) or "could not run because …".
<<<END_DONE>>>

The DONE block MUST be written in Vietnamese (tiếng Việt). Omit ASSUMPTIONS/RISKS lines when empty.
${gitlabCommentInstructions(issue)}${extraBlock}`;
}

export function buildResumePrompt(
  answer: string,
  issue: IssueJob,
  opts?: { clarifyRoundsLeft?: number },
): string {
  const budget = clarifyBudgetLine(opts?.clarifyRoundsLeft);
  return `The human answered your clarification in the Flow Auto Work UI:

---
${answer}
---

Continue the same workflow on the CURRENT branch (do not switch branches).
Implement now. If the answer only partially resolves your questions, fill the remaining small gaps yourself (repo search first, then safe assumptions recorded under ASSUMPTIONS) — do not bounce the same question back.
${budget ? `${budget}\n` : ""}Only use NEED_CLARIFICATION again for a NEW blocking gap (batch all questions, numbered, with options + recommended default).
Leave file changes uncommitted — do NOT \`git commit\` or \`git push\` (orchestrator commits to GitLab via API).
Then end with the DONE block (SUMMARY / ASSUMPTIONS / RISKS / TESTED) in Vietnamese (tiếng Việt).`;
}

/**
 * Follow-up prompt for a (usually fresh) agent window.
 * Prior chat is injected as text — do not rely on SDK resume (often "already has active run").
 */
export function buildFollowUpPrompt(
  message: string,
  issue: IssueJob,
  opts?: {
    chatHistory?: string;
    contextQualityBlock?: string;
    googleSheetsBlock?: string;
    figmaBlock?: string;
    graphifyBlock?: string;
  },
): string {
  const history = opts?.chatHistory?.trim();
  const historyBlock = history
    ? `
## Prior chat on this job (context only)
${history}

`
    : "";
  const qualityBlock = opts?.contextQualityBlock?.trim()
    ? `${opts.contextQualityBlock.trim()}\n\n`
    : "";
  const sheetsBlock = opts?.googleSheetsBlock?.trim()
    ? `\n${opts.googleSheetsBlock.trim()}\n\n`
    : "";
  const figmaBlock = opts?.figmaBlock?.trim()
    ? `\n${opts.figmaBlock.trim()}\n\n`
    : "";

  return `You are working on GitLab issue #${issue.issueIid} ("${issue.title}") in a Cursor agent window.
This may be a **new** window — use prior chat + the repo (inspect if needed). Do not assume old tool state is still loaded.
Prefer \`AGENTS.md\` (then \`.cursor/rules\` / project docs) when you need conventions for **this** checkout.
${opts?.graphifyBlock ? `${opts.graphifyBlock}\n` : ""}${qualityBlock}${sheetsBlock}${figmaBlock}${historyBlock}## Human follow-up (this turn)
${message.trim()}

## How to behave (IDE-like)
1. If they ask a question → answer clearly (Vietnamese if they wrote Vietnamese). Start repo lookup with \`code_map_query\` when that tool is attached.
2. If they ask to fix / add / change / re-test / seed data / run something → **do it** on the CURRENT branch (do not switch branches).
3. Prefer small, correct changes. Stay scoped to this issue unless they explicitly expand scope.
4. If the request is vague: search the repo/docs first; minor gaps → proceed with the standard interpretation and say so in your reply; only end with NEED_CLARIFICATION when truly blocked (batch ALL questions, numbered, with options + your recommended default).
5. Do NOT \`git commit\`, \`git push\`, force-push, amend remote commits, or open/merge MRs. Flow Auto Work commits to GitLab via API after you finish.
6. If finished this follow-up, end with DONE (summary in Vietnamese; note any assumptions you made).

## Chat reply style (UI is a narrow chat panel — keep it readable)
- Put the **full answer the human asked for in the readable body** (above any machine tags). Flow shows that body in chat — NOT the DONE line alone.
- When they ask to **phân tích / analyze / review / giải thích / plan**: write a structured analysis in Vietnamese (mục tiêu, phạm vi, neo code/API, rủi ro, đề xuất bước tiếp). Prefer bullets; skip giant Markdown tables.
- When they ask a short status / yes-no: **1–2 câu** + vài bullet là đủ.
- Không hiện thẻ máy kiểu \`<<<DONE>>>\` trong phần người đọc; DONE chỉ ở cuối, **1 câu status** (vd. "Đã phân tích #…; chưa code.").
- Tránh lặp lại "Muốn sửa code thêm → Bật Run" trừ khi họ hỏi tiếp.

${gitlabCommentInstructions(issue)}<<<NEED_CLARIFICATION>>> / <<<DONE>>> blocks same as usual when applicable.`;
}

/** Free session (hotfix / adhoc) — no GitLab issue yet. */
export function buildAdhocFollowUpPrompt(
  message: string,
  sessionTitle: string,
  opts?: {
    chatHistory?: string;
    contextQualityBlock?: string;
    googleSheetsBlock?: string;
    figmaBlock?: string;
    graphifyBlock?: string;
  },
): string {
  const title = sessionTitle.replace(/\s+/g, " ").trim() || "Ad-hoc session";
  const history = opts?.chatHistory?.trim();
  const historyBlock = history
    ? `
## Prior chat on this session (context only)
${history}

`
    : "";
  const qualityBlock = opts?.contextQualityBlock?.trim()
    ? `${opts.contextQualityBlock.trim()}\n\n`
    : "";
  const sheetsBlock = opts?.googleSheetsBlock?.trim()
    ? `\n${opts.googleSheetsBlock.trim()}\n\n`
    : "";
  const figmaBlock = opts?.figmaBlock?.trim()
    ? `\n${opts.figmaBlock.trim()}\n\n`
    : "";

  return `You are in a **free Cursor agent session** (hotfix / ad-hoc) titled "${title}".
There is **no GitLab issue yet** — a human may create one later from your summary.
This may be a **new** window — use prior chat + the repo (inspect if needed).
Prefer \`AGENTS.md\` (then \`.cursor/rules\` / project docs) when you need conventions for **this** checkout.
${opts?.graphifyBlock ? `${opts.graphifyBlock}\n` : ""}${qualityBlock}${sheetsBlock}${figmaBlock}${historyBlock}## Human request (this turn)
${message.trim()}

## How to behave (IDE-like)
1. If they ask a question → answer clearly (Vietnamese if they wrote Vietnamese). Start repo lookup with \`code_map_query\` when that tool is attached.
2. If they ask to fix / add / change / re-test / seed data / run something → **do it** on the CURRENT branch (do not switch branches).
3. Prefer small, correct changes. Stay scoped to the request.
4. If the request is vague: search the repo first; minor gaps → proceed with the standard interpretation and say so in your reply; only end with NEED_CLARIFICATION when truly blocked (batch ALL questions, numbered, with options + your recommended default).
5. Do NOT \`git commit\`, \`git push\`, force-push, amend remote commits, or open/merge MRs. Flow Auto Work commits to GitLab via API after you finish.
6. If finished this follow-up, end with DONE (summary in Vietnamese — useful as issue description later; note any assumptions you made).

## Chat reply style (UI is a narrow chat panel — keep it readable)
- Put the **full answer the human asked for in the readable body** (above any machine tags). Flow shows that body in chat — NOT the DONE line alone.
- When they ask to **phân tích / analyze / review / giải thích / plan**: write a structured analysis in Vietnamese (mục tiêu, phạm vi, neo code, rủi ro, bước tiếp). Prefer bullets; skip giant Markdown tables.
- When they ask a short status / yes-no: **1–2 câu** + vài bullet là đủ.
- Không hiện thẻ máy kiểu \`<<<DONE>>>\` trong phần người đọc; DONE chỉ ở cuối, **1 câu status**.
- Tránh lặp lại "Muốn sửa code thêm → Bật Run" trừ khi họ hỏi tiếp.

<<<NEED_CLARIFICATION>>> / <<<DONE>>> blocks same as usual when applicable.`;
}

export function parseAgentOutcome(text: string): {
  kind: "done" | "docs_ready" | "plan_ready" | "need_clarification" | "unknown";
  question?: string;
  summary?: string;
} {
  const clarify = text.match(
    /<<<NEED_CLARIFICATION>>>\s*([\s\S]*?)\s*<<<END_NEED_CLARIFICATION>>>/,
  );
  if (clarify) {
    return { kind: "need_clarification", question: clarify[1].trim() };
  }

  const docsReady = text.match(
    /<<<DOCS_READY>>>\s*([\s\S]*?)\s*<<<END_DOCS_READY>>>/,
  );
  if (docsReady) {
    return { kind: "docs_ready", summary: docsReady[1].trim() };
  }

  const planReady = text.match(
    /<<<PLAN_READY>>>\s*([\s\S]*?)\s*<<<END_PLAN_READY>>>/,
  );
  if (planReady) {
    return { kind: "plan_ready", summary: planReady[1].trim() };
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

/**
 * Human-readable chat body from agent output.
 * Prefer the prose BEFORE machine tags (DONE / NEED_CLARIFICATION / …) —
 * that is where analysis / answers live. Fall back to summary/question only
 * when the prose is empty (legacy one-liner DONE-only replies).
 */
export function extractChatBodyFromAgentText(
  text: string,
  opts?: { summary?: string; question?: string; maxChars?: number },
): string {
  const max = opts?.maxChars ?? 12_000;
  let body = (text || "")
    .replace(
      /<<<GITLAB_COMMENT>>>\s*[\s\S]*?\s*<<<END_GITLAB_COMMENT>>>/gi,
      "",
    )
    .replace(
      /<<<NEED_CLARIFICATION>>>\s*[\s\S]*?\s*<<<END_NEED_CLARIFICATION>>>/gi,
      "",
    )
    .replace(/<<<DOCS_READY>>>\s*[\s\S]*?\s*<<<END_DOCS_READY>>>/gi, "")
    .replace(/<<<PLAN_READY>>>\s*[\s\S]*?\s*<<<END_PLAN_READY>>>/gi, "")
    .replace(/<<<DONE>>>\s*[\s\S]*?\s*<<<END_DONE>>>/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  // Drop trailing "DONE:" / "SUMMARY:" leftovers if agent forgot the tags
  body = body
    .replace(/\n*(?:<<<)?(?:END_)?DONE(?:>{3})?\s*$/i, "")
    .trim();

  const summary = opts?.summary?.trim() || "";
  const question = opts?.question?.trim() || "";

  // Prefer full prose when it is substantially more than the short DONE line
  if (body.length >= 80 || (body && body.length > summary.length + 20)) {
    return body.slice(0, max);
  }
  if (summary) return summary.slice(0, max);
  if (question) return question.slice(0, max);
  if (body) return body.slice(0, max);
  return "(no reply)";
}
