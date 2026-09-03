import { describe, expect, it } from "vitest";
import {
  codingAgentPolicy,
  planAgentPolicy,
  READ_ONLY_DISALLOWED_TOOLS,
  readOnlyAgentPolicy,
} from "../agentPolicy.js";

describe("agentPolicy", () => {
  it("blocks write tools and subagents for BA/Q&A", () => {
    expect(READ_ONLY_DISALLOWED_TOOLS).toEqual(
      expect.arrayContaining(["edit", "delete", "shell", "task"]),
    );
    expect(readOnlyAgentPolicy().disallowedTools).toEqual(
      READ_ONLY_DISALLOWED_TOOLS,
    );
    expect(READ_ONLY_DISALLOWED_TOOLS).not.toContain("mcp");
    expect(READ_ONLY_DISALLOWED_TOOLS).not.toContain("read");
  });

  it("plan policy uses Cursor plan mode and the same write lock", () => {
    const plan = planAgentPolicy();
    expect(plan.mode).toBe("plan");
    expect(plan.disallowedTools).toEqual(READ_ONLY_DISALLOWED_TOOLS);
    expect(codingAgentPolicy().mode).toBe("agent");
  });
});
