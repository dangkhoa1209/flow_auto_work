import type { AgentDefinition, AgentModeOption, ToolName } from "@cursor/sdk";
import { WORK_CODING_SUBAGENTS } from "./workSubagents.js";

/**
 * Workspace-mutating tools + subagents (subagents keep their own toolsets,
 * including edit — must block `task` or BA/Q&A can still write via subagent).
 *
 * Keep `mcp` available so BA graphify/DB customTools still work.
 */
export const READ_ONLY_DISALLOWED_TOOLS: ToolName[] = [
  "edit",
  "delete",
  "shell",
  "applyAgentDiff",
  "generateImage",
  "task",
];

/** BA Chat, Create issue, workflow, Q&A, QC testcase, stats — no file edits. */
export function readOnlyAgentPolicy(): {
  disallowedTools: ToolName[];
} {
  return { disallowedTools: READ_ONLY_DISALLOWED_TOOLS };
}

/** /work Plan-first: Cursor `mode: "plan"` plus the same write lock (no Task/subagents). */
export function planAgentPolicy(): {
  mode: AgentModeOption;
  disallowedTools: ToolName[];
} {
  return { mode: "plan", disallowedTools: READ_ONLY_DISALLOWED_TOOLS };
}

/**
 * /work code + follow-up Send: full tools + named subagents (explore / review / tests).
 * Re-pass `agents` on Agent.resume — SDK does not persist them on the agent row.
 */
export function codingAgentPolicy(): {
  mode: AgentModeOption;
  agents: Record<string, AgentDefinition>;
} {
  return { mode: "agent", agents: WORK_CODING_SUBAGENTS };
}
