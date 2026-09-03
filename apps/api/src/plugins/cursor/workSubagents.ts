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
      "Fast codebase exploration: find files, symbols, call paths, and existing patterns before editing. Prefer for large or unfamiliar modules.",
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
      "Review recent or proposed code changes for bugs, regressions, security, and mismatch with the ticket. Use after implementing a non-trivial change.",
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
      "Write or extend focused unit/integration tests for the code just changed. Prefer existing test layout and runners in the repo.",
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
