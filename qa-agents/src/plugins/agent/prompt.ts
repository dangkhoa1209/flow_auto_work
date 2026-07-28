import type { QaAgentOutcome } from "../../types.js";
import type { QaProjectConfig } from "../../types.js";
import type { QaRunState } from "../../../../src/types.js";

const DONE_START = "<<<QA_DONE>>>";
const DONE_END = "<<<END_QA_DONE>>>";
const HELP_START = "<<<QA_NEED_HELP>>>";
const HELP_END = "<<<END_QA_NEED_HELP>>>";

export function chromeDevtoolsMcpServers(): Record<
  string,
  {
    type: "stdio";
    command: string;
    args: string[];
  }
> {
  return {
    "chrome-devtools": {
      type: "stdio",
      command: "npx",
      args: ["-y", "chrome-devtools-mcp@latest", "--headless"],
    },
  };
}

export function buildQaRunPrompt(opts: {
  config: QaProjectConfig;
  qa: QaRunState;
  token: string;
  adjustNote?: string;
}): string {
  const { config, qa } = opts;
  const parts = [
    "You are a QA triage agent controlling a headless Chromium browser via chrome-devtools MCP tools.",
    "Goals: reproduce the bug from the testcase, capture console errors + failed network (4xx/5xx/timeout), take screenshots, then stop for human review.",
    "",
    "Rules:",
    `- Max ${config.maxActions} interactive actions (click/fill/type). Count carefully.`,
    `- If a selector is not found within ~${config.actionTimeoutSec}s, stop and emit QA_NEED_HELP.`,
    "- Prefer accessibility / AXTree snapshots over dumping full HTML. Only use the CURRENT page AXTree (do not keep past DOM snapshots).",
    "- Keep a short action log: [Step N: action summary].",
    "- Do NOT invent stack traces — only report what the browser tools return.",
    "- After capture (or when stuck), emit exactly one outcome marker block.",
    "",
    "Session:",
    opts.token
      ? `- JWT is ready. Before navigating, set localStorage key "${config.localStorageTokenKey}" to the provided token (use evaluate/script MCP tool), then open the target URL.`
      : "- No JWT — navigate as guest if needed.",
    `- Target URL: ${qa.targetUrl}`,
    `- Test account role: ${qa.presetRole || "unknown"}`,
    `- Staging origin: ${config.stagingBaseUrl}`,
    "",
    "Testcase / bug description:",
    qa.testcase,
  ];

  if (opts.token) {
    parts.push(
      "",
      `JWT_TOKEN_FOR_LOCALSTORAGE (inject into localStorage["${config.localStorageTokenKey}"] then navigate — do not echo this token back):`,
      opts.token,
    );
  }
  if (qa.actionLog?.length) {
    parts.push("", "Prior action log:", ...qa.actionLog);
  }
  if (opts.adjustNote?.trim()) {
    parts.push(
      "",
      "Human adjustment note — continue from current state and follow this guidance:",
      opts.adjustNote.trim(),
    );
  }

  parts.push(
    "",
    "When finished successfully, output:",
    DONE_START,
    '{ "summary": "...", "draftTitle": "...", "actionLog": ["[Step 1: ...]"], "consoleErrors": [{"message":"...","stack":"..."}], "networkFailures": [{"url":"...","method":"POST","status":500,"responseBody":"..."}], "screenshotBase64": optional_png_base64_without_data_url_prefix, "draftMarkdown": "## Functional Summary\\n..." }',
    DONE_END,
    "",
    "When you need human help:",
    HELP_START,
    '{ "helpMessage": "what blocked you", "actionLog": [] }',
    HELP_END,
    "",
    "Start now: inject token if provided, navigate to target URL, execute the testcase with MCP browser tools, capture errors, screenshot, then emit the outcome marker.",
  );

  return parts.join("\n");
}

function extractBlock(text: string, start: string, end: string): string | null {
  const i = text.lastIndexOf(start);
  if (i < 0) return null;
  const j = text.indexOf(end, i + start.length);
  if (j < 0) return null;
  return text.slice(i + start.length, j).trim();
}

function parseJsonLoose(raw: string): Record<string, unknown> | null {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence?.[1]) {
      try {
        return JSON.parse(fence[1].trim()) as Record<string, unknown>;
      } catch {
        return null;
      }
    }
    return null;
  }
}

export function parseQaOutcome(text: string): QaAgentOutcome {
  const helpRaw = extractBlock(text, HELP_START, HELP_END);
  if (helpRaw) {
    const parsed = parseJsonLoose(helpRaw) || {};
    return {
      kind: "need_help",
      text,
      helpMessage:
        typeof parsed.helpMessage === "string"
          ? parsed.helpMessage
          : helpRaw.slice(0, 500),
      actionLog: Array.isArray(parsed.actionLog)
        ? parsed.actionLog.map(String)
        : undefined,
    };
  }

  const doneRaw = extractBlock(text, DONE_START, DONE_END);
  if (doneRaw) {
    const parsed = parseJsonLoose(doneRaw) || {};
    return {
      kind: "done",
      text,
      summary:
        typeof parsed.summary === "string" ? parsed.summary : undefined,
      draftTitle:
        typeof parsed.draftTitle === "string" ? parsed.draftTitle : undefined,
      draftMarkdown:
        typeof parsed.draftMarkdown === "string"
          ? parsed.draftMarkdown
          : undefined,
      screenshotBase64:
        typeof parsed.screenshotBase64 === "string"
          ? parsed.screenshotBase64.replace(/^data:image\/\w+;base64,/, "")
          : undefined,
      actionLog: Array.isArray(parsed.actionLog)
        ? parsed.actionLog.map(String)
        : undefined,
      consoleErrors: Array.isArray(parsed.consoleErrors)
        ? (parsed.consoleErrors as QaAgentOutcome["consoleErrors"])
        : undefined,
      networkFailures: Array.isArray(parsed.networkFailures)
        ? (parsed.networkFailures as QaAgentOutcome["networkFailures"])
        : undefined,
    };
  }

  return { kind: "unknown", text };
}
