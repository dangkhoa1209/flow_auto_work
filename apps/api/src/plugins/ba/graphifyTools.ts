import {
  compactGraphifyQueryOutput,
  explainProjectGraphify,
  graphifyEnabled,
  pathProjectGraphify,
  queryProjectGraphify,
} from "../../workspace/graphify.js";

type CustomTool = {
  description: string;
  inputSchema: Record<string, unknown>;
  /** MCP Tool.outputSchema — descriptive only; results are not validated. */
  outputSchema?: Record<string, unknown>;
  /** MCP tool annotations (hints for the model). */
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  execute: (args: Record<string, unknown>) => Promise<string>;
};

const READ_ONLY_MAP_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const TEXT_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    text: { type: "string", description: "Graphify result text" },
  },
} as const;

/**
 * Cursor SDK custom tools — one short map query before any repo-wide search.
 * Graph lives outside source/; tools never write the checkout.
 */
export function buildBaGraphifyCustomTools(
  sourcePath: string,
): Record<string, CustomTool> {
  if (!graphifyEnabled()) return {};

  return {
    code_map_query: {
      description:
        "Required before a repo-wide search when the file is unknown. " +
        "You choose one locator (screen, module, or symbol) — not the full issue, description, or chat. " +
        "Good: 'cấu hình rules chấm công', 'TimekeeperSync'. " +
        "Read 1–3 files it returns. If the list is off-target, call again with a tighter locator. " +
        "Use code_map_explain or code_map_path only when this returns no files or you need to connect two symbols. " +
        "Skip when the target file is already known.",
      inputSchema: {
        type: "object",
        properties: {
          question: {
            type: "string",
            description:
              "Short screen/module/symbol locator (not the full task or chat)",
          },
        },
        required: ["question"],
      },
      outputSchema: TEXT_OUTPUT_SCHEMA,
      annotations: {
        title: "Code map query",
        ...READ_ONLY_MAP_ANNOTATIONS,
      },
      async execute(args) {
        const question = String(args?.question || "").trim();
        if (!question) return "code_map_query failed: question required";
        const text = await queryProjectGraphify(sourcePath, question);
        const compact = compactGraphifyQueryOutput(text, { asToolResult: true });
        return (
          compact ||
          text ||
          "code_map_query: no hits (graph missing or empty). " +
            "Try a tighter screen/symbol, then code_map_explain — not a repo-wide scan."
        );
      },
    },
    code_map_path: {
      description:
        "Shortest path between two symbols. Call only when code_map_query returned no files, or you need to connect two symbols the query did not already link.",
      inputSchema: {
        type: "object",
        properties: {
          from: { type: "string", description: "Start node / symbol / file hint" },
          to: { type: "string", description: "End node / symbol / file hint" },
        },
        required: ["from", "to"],
      },
      outputSchema: TEXT_OUTPUT_SCHEMA,
      annotations: {
        title: "Code map path",
        ...READ_ONLY_MAP_ANNOTATIONS,
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
        "Neighbors of one symbol. Call only when code_map_query returned no files, or you need neighbors the query did not list. Do not call if the query already listed the files.",
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
      outputSchema: TEXT_OUTPUT_SCHEMA,
      annotations: {
        title: "Code map explain",
        ...READ_ONLY_MAP_ANNOTATIONS,
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

/** Attach graphify custom tools onto a local Agent cwd config when enabled. */
export function withGraphifyCustomTools(cwd: string): {
  cwd: string;
  customTools?: Record<string, CustomTool>;
} {
  const customTools = buildBaGraphifyCustomTools(cwd);
  if (!Object.keys(customTools).length) return { cwd };
  return { cwd, customTools };
}
