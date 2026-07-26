/**
 * Handoff + merge: apply GitLab issue actions, merge work branch via MR API.
 */
import { saveJob } from "../../job-store.js";
import { logger } from "../../logger.js";
import { AppError } from "../../utils/AppError.js";
import { requireJobDoc } from "./lifecycle.js";

export type CompletionActionsInput = {
  assignees?: string[];
  labels?: string[];
  removeLabels?: string[];
  labelMode?: "add" | "set";
  comment?: string;
};

export async function applyCompletionActions(
  jobId: string,
  input: CompletionActionsInput,
) {
  const job = await requireJobDoc(jobId);
  if (job.status !== "awaiting_handoff" && job.status !== "succeeded") {
    throw new AppError(
      "Handoff only for awaiting_handoff (or succeeded retry)",
      409,
    );
  }
  const assignees = (input.assignees ?? [])
    .map((s) => String(s).trim())
    .filter(Boolean);
  const labels = (input.labels ?? [])
    .map((s) => String(s).trim())
    .filter(Boolean);
  const removeLabels = (input.removeLabels ?? [])
    .map((s) => String(s).trim())
    .filter(Boolean);
  const comment = input.comment?.trim();
  if (
    !assignees.length &&
    !labels.length &&
    !removeLabels.length &&
    !comment &&
    input.labelMode !== "set"
  ) {
    throw new AppError("Need assignees, labels, removeLabels, or comment", 400);
  }

  const { applyIssueActions } = await import("../../plugins/gitlab/client.js");
  const { resolveProcessingLabel } = await import(
    "../../plugins/gitlab/processing-label.js"
  );
  const proc = resolveProcessingLabel(job.completion?.processingLabel);
  const removeWithProcessing = [
    ...new Set([...removeLabels, proc].map((s) => s.trim()).filter(Boolean)),
  ];
  await applyIssueActions({
    projectId: job.issue.projectId,
    issueIid: job.issue.issueIid,
    assignees,
    labels,
    removeLabels: removeWithProcessing,
    labelMode: input.labelMode === "set" ? "set" : "add",
    comment,
  });

  job.status = "succeeded";
  job.handedOffAt = new Date().toISOString();
  job.error = undefined;
  await saveJob(job);
  return { ok: true, job };
}

/**
 * Merge job work branch into project/base via GitLab MR API (PAT identity).
 * Same spirit as Commits API — no local git user.name / user.email required.
 */
export async function mergeJobBranch(
  jobId: string,
  input: { targetBranch?: string },
) {
  const job = await requireJobDoc(jobId);
  if (job.status !== "awaiting_handoff" && job.status !== "succeeded") {
    throw new AppError("Merge only for awaiting_handoff or succeeded jobs", 409);
  }
  const source = (job.branch || job.workBranch || "").trim();
  if (!source) {
    throw new AppError("Job has no work branch to merge", 400);
  }
  const { resolveGitlabProjectPath } = await import("../../workspace/creds.js");
  const { getRuntimeContext } = await import("../../workspace/runtime.js");
  const {
    createMergeRequest,
    findOpenMergeRequest,
    acceptMergeRequest,
    getProjectDefaultBranch,
  } = await import("../../plugins/gitlab/client.js");
  const { syncLocalToRemoteCommit } = await import(
    "../../plugins/git/changes-for-api.js"
  );

  const rt = getRuntimeContext();
  const repoPath = rt?.repoPath?.trim() || undefined;
  const projectIdOrPath: number | string =
    rt?.gitlabProjectId ?? job.issue?.projectId ?? resolveGitlabProjectPath();

  let target =
    input.targetBranch?.trim() ||
    job.baseBranch?.trim() ||
    rt?.baseBranch?.trim() ||
    "";
  if (!target) {
    try {
      target = await getProjectDefaultBranch(projectIdOrPath);
    } catch {
      /* fall through */
    }
  }
  if (!target) {
    throw new AppError(
      "Không xác định được target branch (base/default)",
      400,
    );
  }

  job.mergeError = undefined;
  job.mergePushError = undefined;
  await saveJob(job);

  try {
    let mr = await findOpenMergeRequest({
      projectId: projectIdOrPath,
      sourceBranch: source,
      targetBranch: target,
    });
    let createdMr = false;
    if (!mr) {
      const iid = job.issue?.issueIid;
      const title = iid
        ? `Merge #${iid}: ${job.issue?.title || source}`
        : `Merge ${source} into ${target}`;
      const description = [
        iid ? `Closes #${iid}` : null,
        job.summary ? `\n${job.summary}` : null,
        `\n_Merged by Flow Auto Work via GitLab API_`,
      ]
        .filter(Boolean)
        .join("");
      mr = await createMergeRequest({
        projectId: projectIdOrPath,
        sourceBranch: source,
        targetBranch: target,
        title,
        description,
        issueIid: iid,
      });
      createdMr = true;
    }

    const merged = await acceptMergeRequest({
      projectId: projectIdOrPath,
      mergeRequestIid: mr.iid,
      mergeCommitMessage: `Merge branch '${source}' into ${target}`,
      shouldRemoveSourceBranch: false,
    });

    const mergeSha = merged.mergeCommitSha;
    let localSynced = false;
    let syncError: string | undefined;
    if (mergeSha && repoPath) {
      try {
        await syncLocalToRemoteCommit(repoPath, target, mergeSha);
        localSynced = true;
      } catch (err) {
        syncError = err instanceof Error ? err.message : String(err);
        logger.warn("GitLab merge ok but local sync failed", {
          jobId: job.id,
          target,
          sha: mergeSha,
          err: syncError,
        });
      }
    }

    job.mergedAt = new Date().toISOString();
    job.mergeTarget = target;
    job.mergeSource = source;
    job.mergeSha = mergeSha ?? undefined;
    job.mergeAiResolved = false;
    job.mergeError = undefined;
    job.mergePushedAt = new Date().toISOString();
    job.mergePushError = syncError;
    if (mergeSha) {
      job.commitSha = mergeSha;
      job.commitShas = [...(job.commitShas ?? []), mergeSha].slice(-20);
    }
    await saveJob(job);

    logger.info("Job branch merged via GitLab API", {
      jobId: job.id,
      source,
      target,
      sha: mergeSha,
      mrIid: mr.iid,
      createdMr,
      alreadyMerged: merged.alreadyMerged ?? false,
      localSynced,
    });

    return {
      ok: true,
      job,
      merge: {
        source,
        target,
        commitSha: mergeSha,
        alreadyUpToDate: merged.alreadyMerged ?? false,
        via: "gitlab_api",
        mergeRequestIid: mr.iid,
        mergeRequestUrl: merged.webUrl || mr.webUrl,
        createdMr,
        localSynced,
        syncError: syncError ?? null,
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    job.mergeError = msg;
    await saveJob(job);
    logger.warn("Merge via GitLab API failed", { jobId: job.id, err: msg });
    const conflict =
      /cannot_be_merged|conflict|Branch cannot be merged/i.test(msg);
    throw new AppError(msg, conflict ? 409 : 500);
  }
}
