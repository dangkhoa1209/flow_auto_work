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
import { persistCursorUsage } from "../cursor/recordUsage.js";
import { listConflictedFiles, stageClearedConflictFiles } from "../git/merge.js";

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
    return { text: "(không còn conflict)", remaining: [] };
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
3. Do not leave any conflict markers — search the file for leftover \`<<<<<<<\` before finishing.
4. Do not push, do not force-push, do not create MRs.
5. Do not run \`git merge --abort\`. After resolving each file, \`git add\` it.
6. Do NOT create a merge commit yourself — the orchestrator will commit after you finish.
7. Prefer small, correct resolutions over large rewrites.
8. Finish ALL listed files in this turn — do not stop after one file.

## Reply format (REQUIRED — for History UI)
After resolving, reply in **Vietnamese only** (keep file paths / branch names / symbols in original English).
Use this exact shape — short, scannable, no English paragraphs:

**Tóm tắt:** 1–2 câu (merge gì, bao nhiêu file).

Với **mỗi** file conflicted:

### \`path/to/file\`
- **Giữ:** … (nhánh nào / phần nào)
- **Bỏ:** … (nếu có)
- **Lý do:** … (một câu)

Rules for the reply:
- Plain short bullets only — no long English design notes.
- Do not paste code blocks unless a one-liner is essential.
- Do not say "File staged; merge commit left for the orchestrator" — orchestrator handles that.`;

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

  const remainingAfterAi = files;
  // Stage files AI cleared but forgot to git-add (orchestrator also stages).
  const stillMarked = await stageClearedConflictFiles(repoPath, remainingAfterAi);
  const remaining = [
    ...new Set([...(await listConflictedFiles(repoPath)), ...stillMarked]),
  ];
  await persistCursorUsage({
    kind: "job_merge",
    result,
    promptChars: prompt.length,
    outputChars: (result.result ?? "").length,
    model: resolveCursorModel(),
  });
  return {
    text: (result.result ?? "").trim() || "(đã xử lý)",
    remaining,
  };
}
