import type { IssueJob } from "../types.js";
import { stripMediaAndAttachments } from "../gitlab/linked-context.js";

export function commitMessageForIssue(issue: IssueJob): string {
  const title = issue.title.replace(/\s+/g, " ").trim();
  return `feat #${issue.issueIid} ${title}`;
}

export function docsCommitMessageForIssue(issue: IssueJob): string {
  const title = issue.title.replace(/\s+/g, " ").trim();
  return `docs #${issue.issueIid} ${title}`;
}

function sharedPreamble(issue: IssueJob, techLeadNotes?: string): {
  notesBlock: string;
  description: string;
  notes: string;
} {
  const notes = techLeadNotes?.trim() || "";
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

/** Format UI Clarify/Q&A chat into a prompt block for Run. */
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
The human already asked / clarified in the Flow Auto Work Clarify·Q&A chat.
Treat the **latest Human messages** as the active instructions for this run (e.g. connect DB, seed NV, run queue, verify).
Do the work end-to-end when they asked you to execute — this is a full Run, not Q&A mode.

${lines.join("\n\n")}
`;
}

/**
 * Phase A: read/update AiHR feature docs under docs/modules/... (NOT per-issue files).
 */
export function buildDocsPhasePrompt(
  issue: IssueJob,
  linkedContext?: string,
  techLeadNotes?: string,
  opts?: { chatContext?: string },
): string {
  const { notesBlock, description } = sharedPreamble(issue, techLeadNotes);
  const chatBlock = opts?.chatContext?.trim()
    ? `${opts.chatContext.trim()}\n\n`
    : "";
  const linkedBlock = linkedContext?.trim()
    ? `\n## Linked / related context\n${linkedContext.trim()}\n`
    : "";
  const commitMsg = docsCommitMessageForIssue(issue);

  return `# MISSION — DOCS PHASE ONLY (NO APP CODE)
You are preparing documentation for GitLab issue #${issue.issueIid} on AiHR v3 BEFORE any implementation.

Follow AGENTS.md, .cursor/skills/aihr/SKILL.md, and relevant \`.cursor/rules/**/*.mdc\` (docs-loading, project, domain rules).
Ignore image/file attachments — text only.

AiHR knowledge is:
- **Feature docs**: \`docs/\` — module → feature (NOT by GitLab issue/task). Files may be \`.md\` or \`.mdc\`.
- **Rules**: \`.cursor/rules/**/*.mdc\` — system conventions (read; do not invent conflicting guidance).
- Hub: \`docs/README.md\`
- Modules: \`docs/modules/<module>/\`
- Features: \`docs/modules/<module>/<feature>/\` (README + overview / topic docs)
- Templates: \`docs/_templates/\`
- Shared: \`docs/shared/\`

${chatBlock}${notesBlock}# BUSINESS REQUIREMENTS (GITLAB ISSUE #${issue.issueIid})
Title: ${issue.title}
URL: ${issue.url}
Labels: ${issue.labels.join(", ") || "(none)"}

## Description
${description}
${linkedBlock}

# HARD RULES (DOCS PHASE)
1. DO NOT modify application code (no PHP/JS/Vue/TS/CSS outside docs, no migrations, no app config).
2. You MAY create/update docs under \`docs/\` (\`.md\` or \`.mdc\` only). Do NOT edit \`.cursor/rules/\` in this phase unless explicitly required by DEV NOTES.
3. Find the matching **feature** docs (read \`docs/README.md\` then module hub, then feature README). Also skim relevant AiHR rules (\`.cursor/rules/\`, esp. docs-loading). Max ~5 feature docs + needed rules.
4. Update existing feature docs when they already cover this area. Create a new feature folder only if none fits — follow \`docs/_templates/\` and link from the module README.
5. Do NOT create per-issue files like \`docs/flow-auto-work/issues/...\` or \`*-issue-123.md\`. Docs belong to the product feature, not the ticket.
6. Docs should cover (as appropriate for the feature):
   - Mục tiêu / hành vi
   - Phạm vi
   - Code map / API / DB / FE
   - Rủi ro & giả định liên quan task này (có thể ghi ngắn trong doc feature)
   - Plan implement ngắn nếu cần — chưa code
7. Commit with message:

   ${commitMsg}

8. Do NOT push / MR / switch branches. Stay on current branch.
9. When docs are ready, end with EXACTLY this block (paths = feature docs you created/updated; may include \`.md\` / \`.mdc\`):

<<<DOCS_READY>>>
SUMMARY: Tóm tắt ngắn tiếng Việt (1–3 câu): đã đọc/sửa docs feature nào, điểm chính.
DOCS:
- docs/modules/<module>/<feature>/README.md
- docs/modules/<module>/<feature>/overview.md
<<<END_DOCS_READY>>>

List every \`docs/**/*.{md,mdc}\` file you created or substantially updated under DOCS.
10. If blocked, use NEED_CLARIFICATION for the Flow Auto Work UI.
`;
}

export function buildWorkPrompt(
  issue: IssueJob,
  extra?: string,
  linkedContext?: string,
  techLeadNotes?: string,
  opts?: { approvedDocsPaths?: string[]; chatContext?: string },
): string {
  const commitMsg = commitMessageForIssue(issue);
  const { notesBlock, description } = sharedPreamble(issue, techLeadNotes);

  const chatBlock = opts?.chatContext?.trim()
    ? `${opts.chatContext.trim()}\n\n`
    : "";

  const linkedBlock = linkedContext?.trim()
    ? `\n## Linked / related context\n${linkedContext.trim()}\n`
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
PM approved these AiHR docs (\`.md\` / \`.mdc\`). Read them fully and implement accordingly — still obey \`.cursor/rules/**/*.mdc\`:
${paths.map((p) => `- \`${p}\``).join("\n")}
Do not contradict these docs unless DEV NOTES or UI CHAT REQUESTS override a specific point.
`
      : "";

  return `# MISSION
You are an expert developer implementing a feature based on a GitLab issue for AiHR v3.

# AIHR RULES (MANDATORY WHEN CODING)
You MUST follow AiHR conventions — do not invent patterns that contradict them:
1. \`AGENTS.md\`
2. \`.cursor/skills/aihr/SKILL.md\` (workflow)
3. \`.cursor/rules/\` — especially \`00-project.mdc\`, \`docs-loading.mdc\`, plus domain rules that apply (core/, backend/, frontend/, database/, …). Prefer loading only the relevant \`.mdc\` files.
4. Feature docs under \`docs/\` (\`.md\` or \`.mdc\`) for the module/feature you touch.

Load the relevant module/feature docs (max ~3) and applicable rules before changing code.
Do not touch .env, credentials, or secrets.
Do not force-push, do not amend commits already on remote, do not create or merge MRs.
Do NOT switch git branches. Stay on the branch that is already checked out.

${chatBlock}${notesBlock}${docsGateBlock}# BUSINESS REQUIREMENTS (GITLAB ISSUE #${issue.issueIid})
Title: ${issue.title}
URL: ${issue.url}
Labels: ${issue.labels.join(", ") || "(none)"}
Action that triggered this run: ${issue.action}

## Description
${description}
${linkedBlock}
Use linked/mentioned issues and comments above as additional requirements/context. Prefer the primary issue (#${issue.issueIid}) scope; do not expand work into unrelated linked tickets unless required.
Ignore image/file attachments — only use text. Do not try to download or open media.

# EXECUTION PLAN
1. Analyze the requirements but execute them EXACTLY as demanded in UI CHAT REQUESTS and DEV NOTES when present (those override conflicting business wording). Latest Human chat messages win for this run.
2. Investigate via docs (and the approved feature docs if listed above), then write a short plan.
3. Implement on the CURRENT git branch only (do not checkout/create other branches). Keep the change scoped to this issue.
4. Commit exactly with this message format (one commit preferred):

   ${commitMsg}

5. Stop after the commit — do NOT push and do NOT open an MR. The orchestrator treats a successful local commit as done.
6. If requirements are ambiguous or you are not confident which approach to take, do NOT guess.
   The human answers in the **Flow Auto Work UI** (not Teams).
   End your final reply with EXACTLY this block (and nothing after it):

<<<NEED_CLARIFICATION>>>
Your specific question(s) for the human here.
<<<END_NEED_CLARIFICATION>>>

7. If you finished successfully, end with:

<<<DONE>>>
Tóm tắt ngắn bằng tiếng Việt: đã làm gì / thay đổi chính (1–3 câu).
<<<END_DONE>>>

The DONE summary MUST be written in Vietnamese (tiếng Việt).
${extraBlock}`;
}

export function buildResumePrompt(answer: string, issue: IssueJob): string {
  const commitMsg = commitMessageForIssue(issue);
  return `The human answered your clarification in the Flow Auto Work UI:

---
${answer}
---

Continue the same workflow on the CURRENT branch (do not switch branches).
Implement if clear enough; otherwise ask again with the NEED_CLARIFICATION block (UI will collect the next answer).
When finished, commit with message:

${commitMsg}

Then use the DONE block. The DONE summary MUST be in Vietnamese (tiếng Việt). Do not push or open an MR.`;
}

/**
 * Follow-up prompt for a (usually fresh) agent window.
 * Prior chat is injected as text — do not rely on SDK resume (often "already has active run").
 */
export function buildFollowUpPrompt(
  message: string,
  issue: IssueJob,
  opts?: { chatHistory?: string },
): string {
  const commitMsg = commitMessageForIssue(issue);
  const history = opts?.chatHistory?.trim();
  const historyBlock = history
    ? `
## Prior chat on this job (context only)
${history}

`
    : "";

  return `You are working on GitLab issue #${issue.issueIid} ("${issue.title}") in a Cursor agent window.
This may be a **new** window — use prior chat + the repo (inspect if needed). Do not assume old tool state is still loaded.
${historyBlock}## Human follow-up (this turn)
${message.trim()}

## How to behave (IDE-like)
1. If they ask a question → answer clearly (Vietnamese if they wrote Vietnamese). You may briefly inspect the repo.
2. If they ask to fix / add / change / re-test / seed data / run something → **do it** on the CURRENT branch (do not switch branches).
3. Prefer small, correct changes. Stay scoped to this issue unless they explicitly expand scope.
4. Do NOT push, force-push, amend remote commits, or open/merge MRs.
5. If you changed code and are done with this request, commit with:

   ${commitMsg}

6. If you need more info, end with NEED_CLARIFICATION. If finished this follow-up, end with DONE (summary in Vietnamese).

<<<NEED_CLARIFICATION>>> / <<<DONE>>> blocks same as usual when applicable.`;
}

export function parseAgentOutcome(text: string): {
  kind: "done" | "docs_ready" | "need_clarification" | "unknown";
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
