import {
  explainProjectGraphify,
  graphifyEnabled,
  pathProjectGraphify,
  queryProjectGraphify,
} from "../../workspace/graphify.js";

type CustomTool = {
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (args: Record<string, unknown>) => Promise<string>;
};

/**
 * Cursor SDK custom tools — BA agents must use these before Grep/Shell for case-3 lookups.
 * Graph lives outside source/; tools never write the checkout.
 */
export function buildBaGraphifyCustomTools(
  sourcePath: string,
): Record<string, CustomTool> {
  if (!graphifyEnabled()) return {};

  return {
    code_map_query: {
      description:
        "REQUIRED first step when exploring product source for BA answers. " +
        "Runs WorkBench graphify query on the sibling knowledge graph (not inside source/). " +
        "Pass a short Vietnamese or English product question (screen/feature/flow). " +
        "Call this BEFORE Grep, rg, Glob, or find. Returns related files/symbols.",
      inputSchema: {
        type: "object",
        properties: {
          question: {
            type: "string",
            description: "Product/UI question to locate in the codebase map",
          },
        },
        required: ["question"],
      },
      async execute(args) {
        const question = String(args?.question || "").trim();
        if (!question) return "code_map_query failed: question required";
        const text = await queryProjectGraphify(sourcePath, question);
        return (
          text ||
          "code_map_query: no hits (graph missing or empty). " +
            "You may try code_map_explain, then a narrow locale Grep — not a repo-wide scan."
        );
      },
    },
    code_map_path: {
      description:
        "Shortest path between two code/symbol names in the WorkBench graphify graph. " +
        "Use after code_map_query when you need how A connects to B.",
      inputSchema: {
        type: "object",
        properties: {
          from: { type: "string", description: "Start node / symbol / file hint" },
          to: { type: "string", description: "End node / symbol / file hint" },
        },
        required: ["from", "to"],
      },
      async execute(args) {
        const from = String(args?.from || "").trim();
        const to = String(args?.to || "").trim();
        if (!from || !to) return "code_map_path failed: from and to required";
        const text = await pathProjectGraphify(sourcePath, from, to);
        return text || "code_map_path: no path found";
      },
    },
    code_map_explain: {
      description:
        "Explain a concept/symbol and neighbors from the WorkBench graphify graph. " +
        "Use when code_map_query is thin and you need focus on one module/screen name.",
      inputSchema: {
        type: "object",
        properties: {
          concept: {
            type: "string",
            description: "Module, screen, or symbol to explain",
          },
        },
        required: ["concept"],
      },
      async execute(args) {
        const concept = String(args?.concept || "").trim();
        if (!concept) return "code_map_explain failed: concept required";
        const text = await explainProjectGraphify(sourcePath, concept);
        return text || "code_map_explain: nothing found";
      },
    },
  };
}

/** Merge graphify + optional DB tools for Agent.create local.customTools. */
export function mergeBaAgentCustomTools(
  sourcePath: string,
  dbTools?: Record<string, CustomTool> | null,
): Record<string, CustomTool> {
  return {
    ...buildBaGraphifyCustomTools(sourcePath),
    ...(dbTools || {}),
  };
}
