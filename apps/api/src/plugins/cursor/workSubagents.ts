import type { AgentDefinition } from "@cursor/sdk";

/**
 * Named subagents for /work coding agents (SDK `agents` + Task tool).
 * Parent keeps full tools; these specialize context windows for explore /
 * review / tests so the main agent stays focused.
 *
 * Pass again on Agent.resume — not persisted on the agent row.
 */
export const WORK_CODING_SUBAGENTS: Record<string, AgentDefinition> = {
  explore: {
    description:
      "Use only when path/module is still unclear after code_map/search, or search would span many files — locate files, symbols, call paths. Skip if the target file is already known. Part of /work coding flow step 1 (before first edit).",
    prompt: `You are a read-focused codebase explorer for Flow Auto Work /work jobs.
Goal: locate the right files, symbols, and patterns quickly and report findings.
- Prefer search (grep/glob/semSearch/read) over guessing paths.
- Do not invent file paths that do not exist.
- Keep edits minimal — only if the parent explicitly asked you to change code; otherwise return a concise map of what you found (paths + why they matter).
- End with a short bullet summary the parent can act on.`,
    model: "inherit",
  },
  "code-reviewer": {
    description:
      "Use only after non-trivial diffs (multi-file, shared logic, auth/money/data) — review bugs, regressions, security, ticket fit before DONE. Skip for small single-file edits already re-read. Part of /work coding flow after implement.",
    prompt: `You are a strict code reviewer for a Flow Auto Work /work job.
Focus on correctness, regressions, security, and ticket fit — not style nits.
- Read the changed / relevant files; cite paths.
- Separate: blockers vs suggestions.
- Do not rewrite large areas unless a blocker requires a concrete patch.
- Return a structured review the parent can merge or act on.`,
    model: "inherit",
  },
  "test-writer": {
    description:
      "Use only when behavior changed and a nearby test harness exists — write/extend focused tests for the code just changed. Skip if no tests nearby or change is docs/copy-only. Part of /work coding flow before DONE.",
    prompt: `You are a test specialist for a Flow Auto Work /work job.
- Match the repo's existing test style, paths, and runner (vitest/jest/etc.).
- Cover the behavior just implemented; avoid unrelated broad suites.
- Run the cheapest targeted test command when available and report results.
- Leave tests uncommitted; do not git commit/push.`,
    model: "inherit",
  },
};

/** Human-readable labels for Process tab. */
export function workSubagentLabel(name: string | undefined): string {
  const key = (name || "").trim().toLowerCase();
  if (key === "explore") return "explore";
  if (key === "code-reviewer" || key === "reviewer") return "code-reviewer";
  if (key === "test-writer" || key === "test") return "test-writer";
  return key || "subagent";
}
