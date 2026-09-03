import { Agent } from "@cursor/sdk";
import { logger } from "../../logger.js";
import type { IssueJob } from "../../types.js";
import {
  resolveCursorApiKey,
  resolveCursorModel,
  resolveCursorModelSpec,
  resolveRepoPath,
} from "../../workspace/creds.js";
import { cursorModelLogLabel } from "../cursor/modelSpec.js";
import { listConflictedFiles } from "../git/merge.js";

/**
 * Ask Cursor agent to resolve git merge conflict markers in-place.
 */
export async function resolveMergeConflictsWithAi(opts: {
  sourceBranch: string;
  targetBranch: string;
  conflictedFiles: string[];
  issue?: IssueJob;
}): Promise<{ text: string; remaining: string[] }> {
  const repoPath = resolveRepoPath();
  const files = opts.conflictedFiles.length
    ? opts.conflictedFiles
    : await listConflictedFiles(repoPath);

  if (!files.length) {
    return { text: "(no conflicts)", remaining: [] };
  }

  const issueBit = opts.issue
    ? `Related issue #${opts.issue.issueIid}: ${opts.issue.title}\n${opts.issue.url}\n`
    : "";

  const prompt = `You are resolving a LOCAL git merge conflict.

${issueBit}
Merging branch \`${opts.sourceBranch}\` INTO \`${opts.targetBranch}\`.

Conflicted files:
${files.map((f) => `- ${f}`).join("\n")}

## Your job
1. Open each conflicted file and resolve EVERY conflict marker (\`<<<<<<<\`, \`=======\`, \`>>>>>>>\`).
2. Keep the intended feature behavior from the source branch when it is the feature work; preserve necessary base-branch fixes.
3. Do not leave any conflict markers.
4. Do not push, do not force-push, do not create MRs.
5. Do not run \`git merge --abort\`. You may \`git add\` the resolved files.
6. Do NOT create a merge commit yourself — the orchestrator will commit after you finish.
7. Prefer small, correct resolutions over large rewrites.

When done, reply with a short summary of how you resolved each file.`;

  const model = resolveCursorModelSpec();
  const modelLabel = cursorModelLogLabel(resolveCursorModel());
  logger.info("AI merge conflict resolution starting", {
    source: opts.sourceBranch,
    target: opts.targetBranch,
    files,
    model: modelLabel,
  });

  const result = await Agent.prompt(prompt, {
    apiKey: resolveCursorApiKey(),
    model,
    local: { cwd: repoPath },
  });

  if (result.status === "error") {
    throw new Error(`AI conflict resolve failed: ${result.id}`);
  }

  const remaining = await listConflictedFiles(repoPath);
  return {
    text: (result.result ?? "").trim() || "(done)",
    remaining,
  };
}
