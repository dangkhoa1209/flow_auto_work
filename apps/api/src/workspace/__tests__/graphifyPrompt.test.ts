import { describe, expect, it } from "vitest";
import { formatWorkGraphifyPromptBlock } from "../graphify.js";

describe("formatWorkGraphifyPromptBlock", () => {
  it("instructs Work agents to call code_map_query before Grep", () => {
    const block = formatWorkGraphifyPromptBlock({
      sourcePath: "/tmp/project/user/app/source",
      queryText: "AuthModule → LoginView",
    });
    expect(block).toMatch(/code_map_query/);
    expect(block).toContain("AuthModule → LoginView");
    expect(block).toMatch(/graphify-out/);
    expect(block).not.toMatch(/INTENT = case 3/);
  });

  it("tells the agent to query when no map is precomputed", () => {
    const block = formatWorkGraphifyPromptBlock({
      sourcePath: "/tmp/project/user/app/source",
      queryText: null,
    });
    expect(block).toMatch(/MUST call tool code_map_query/i);
  });
});
