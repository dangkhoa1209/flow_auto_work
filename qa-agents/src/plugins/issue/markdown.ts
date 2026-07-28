import type {
  QaConsoleError,
  QaNetworkFailure,
  QaRunState,
} from "../../../../src/types.js";

/**
 * Build the hard GitLab issue markdown template from QA capture state.
 */
export function buildQaIssueMarkdown(opts: {
  qa: QaRunState;
  screenshotMarkdownUrl?: string;
  functionalSummary?: string;
}): string {
  const { qa } = opts;
  const primary = qa.networkFailures?.[0];
  const summary =
    opts.functionalSummary?.trim() ||
    qa.testcase.trim() ||
    "(no summary)";

  const lines: string[] = [
    "## Functional Summary",
    "",
    summary,
    "",
    "## Technical Stack Trace (Auto-Captured)",
    "",
  ];

  if (primary) {
    lines.push(
      `> **Primary Failed Request:** \`${primary.method} ${primary.url}\` (Status: ${primary.status})`,
      "",
    );
  } else {
    lines.push("> **Primary Failed Request:** _(none captured)_", "");
  }

  lines.push("### Frontend Initiator & Source Trace", "");
  if (primary?.initiator) {
    lines.push(`- **Initiator:** \`${primary.initiator}\``);
  } else {
    lines.push("- **Initiator:** _(not available in MVP — source map deferred)_");
  }
  lines.push("");

  lines.push("### Console Runtime Errors", "", "```text");
  if (qa.consoleErrors?.length) {
    for (const err of qa.consoleErrors) {
      lines.push(formatConsoleError(err));
      lines.push("");
    }
  } else {
    lines.push("(no console errors captured)");
  }
  lines.push("```", "");

  lines.push("### Failed Network Request Payload", "");
  if (primary) {
    lines.push(`- **URL:** \`${primary.url}\``);
    lines.push(`- **Method:** \`${primary.method}\``);
    lines.push(`- **Response Body:**`, "", "```json");
    lines.push(prettyJson(primary.responseBody) || "{}");
    lines.push("```", "");
  } else if (qa.networkFailures?.length) {
    for (const n of qa.networkFailures) {
      lines.push(`- \`${n.method} ${n.url}\` → ${n.status}`);
    }
    lines.push("");
  } else {
    lines.push("_(no failed network requests)_", "");
  }

  lines.push("## Environment & Screenshots", "");
  lines.push(`- **Target URL:** \`${qa.targetUrl}\``);
  lines.push(`- **Test Account Role:** \`${qa.presetRole || "unknown"}\``);
  if (opts.screenshotMarkdownUrl) {
    lines.push(
      `- **Captured Screenshot:** ![Bug Screenshot](${opts.screenshotMarkdownUrl})`,
    );
  } else {
    lines.push("- **Captured Screenshot:** _(none)_");
  }
  lines.push("");

  if (qa.actionLog?.length) {
    lines.push("### Action Log", "");
    for (const step of qa.actionLog) {
      lines.push(`- ${step}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function formatConsoleError(err: QaConsoleError): string {
  if (err.stack?.trim()) return `${err.message}\n${err.stack}`;
  return err.message;
}

function prettyJson(raw?: string): string {
  if (!raw?.trim()) return "";
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw.slice(0, 4000);
  }
}

export function mergeCaptureIntoQa(
  qa: QaRunState,
  patch: {
    actionLog?: string[];
    consoleErrors?: QaConsoleError[];
    networkFailures?: QaNetworkFailure[];
    draftMarkdown?: string;
    draftTitle?: string;
    summary?: string;
  },
): QaRunState {
  return {
    ...qa,
    actionLog: patch.actionLog?.length ? patch.actionLog : qa.actionLog,
    consoleErrors: patch.consoleErrors?.length
      ? patch.consoleErrors
      : qa.consoleErrors,
    networkFailures: patch.networkFailures?.length
      ? patch.networkFailures
      : qa.networkFailures,
    draftMarkdown: patch.draftMarkdown || qa.draftMarkdown,
    draftTitle: patch.draftTitle || qa.draftTitle,
  };
}
