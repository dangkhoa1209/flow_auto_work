import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  fetchGitlabProject,
  listGitlabBranches,
  listMyGitlabProjects,
  listProjectMilestones,
  verifyGitlabTokenUser,
} from "../../plugins/gitlab/client.js";
import {
  activateProject,
  createUserProject,
  deleteUserProject,
  getMembership,
  getProject,
  getUserSecrets,
  listMembershipsForUser,
  renameProjectLocalFolder,
  updateProjectFields,
  upsertProject,
} from "../../workspace/store.js";
import { defaultLocalPath, normalizeGitlabHost } from "../../workspace/types.js";
import { assertProjectCloneReady } from "../../workspace/resolve.js";
import { buildOauthCloneUrl, isGitRepo, runGitClone } from "../../workspace/clone.js";
import { AppError } from "../../utils/AppError.js";
import { logger } from "../../logger.js";

const execFileAsync = promisify(execFile);

/** Project shape safe to send to the UI (never exposes the encrypted PAT). */
export function publicProject(project: Awaited<ReturnType<typeof getProject>>) {
  if (!project) return null;
  return {
    id: project.id,
    userId: project.userId,
    projectName: project.projectName,
    displayName: project.displayName,
    gitlabHost: project.gitlabHost,
    gitlabPath: project.gitlabPath,
    gitlabProjectId: project.gitlabProjectId ?? null,
    localPath: project.localPath,
    repoPath: project.repoPath || project.localPath,
    mainBranch: project.mainBranch ?? null,
    workingBranch: project.workingBranch ?? null,
    defaultCommitMode:
      project.defaultCommitMode === "manual" ? "manual" : "auto",
    allowedMilestones: Array.isArray(project.allowedMilestones)
      ? project.allowedMilestones
          .map((t) => String(t).trim())
          .filter(Boolean)
      : [],
    isActive: project.isActive,
    cloneStatus: project.cloneStatus,
    cloneError: project.cloneError ?? null,
    hasGitlabToken: Boolean(project.gitlabTokenEnc),
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
}

export function sanitizeMembership(m: {
  id: string;
  userId: string;
  projectId: string;
  baseBranch?: string;
  workBranch?: string;
  role: string;
  joinedAt: string;
  updatedAt: string;
  project: NonNullable<Awaited<ReturnType<typeof getProject>>>;
}) {
  return {
    id: m.id,
    userId: m.userId,
    projectId: m.projectId,
    baseBranch: m.baseBranch,
    workBranch: m.workBranch,
    role: m.role,
    joinedAt: m.joinedAt,
    updatedAt: m.updatedAt,
    project: publicProject(m.project),
  };
}

export async function listPublicMemberships(username: string) {
  return (await listMembershipsForUser(username)).map(sanitizeMembership);
}

function requireUser(username: string): string {
  const user = username.trim();
  if (!user) throw new AppError("X-Flow-User required", 401);
  return user;
}

function asAppError(err: unknown, status = 400): AppError {
  if (err instanceof AppError) return err;
  return new AppError(err instanceof Error ? err.message : String(err), status);
}

/** Empty array clears restriction; omit/undefined leaves unchanged at call sites. */
export function normalizeAllowedMilestones(
  raw?: string[] | null,
): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) return undefined;
  const titles = [
    ...new Set(
      raw.map((t) => String(t).trim()).filter(Boolean),
    ),
  ].sort((a, b) => a.localeCompare(b));
  return titles;
}

/** Resolve default clone path without creating a project. */
export function getDefaultProjectPath(username: string, projectName?: string) {
  const user = requireUser(username);
  return {
    localPath: defaultLocalPath(user, (projectName || "project").trim()),
  };
}

export type CreateProjectBody = {
  projectName?: string;
  gitlabPath?: string;
  gitlabToken?: string;
  gitlabHost?: string;
  localPath?: string;
  mainBranch?: string;
  workingBranch?: string;
  defaultCommitMode?: "manual" | "auto";
  allowedMilestones?: string[];
  displayName?: string;
  activate?: boolean;
};

/** Create a user-owned project (PAT on project). Does not clone until /clone. */
export async function createProject(username: string, body: CreateProjectBody) {
  const user = requireUser(username);
  const projectName = body.projectName?.trim();
  const gitlabPath = body.gitlabPath?.trim();
  if (!projectName || !gitlabPath) {
    throw new AppError("projectName and gitlabPath required", 400);
  }
  try {
    let gitlabProjectId: number | undefined;
    if (body.gitlabToken?.trim()) {
      try {
        const gl = await fetchGitlabProject(gitlabPath, body.gitlabToken.trim());
        gitlabProjectId = gl.id;
      } catch (err) {
        logger.warn("Could not resolve GitLab project id on create", {
          err: String(err),
        });
      }
    }
    const usedDefaultPath = !body.localPath?.trim();
    const project = await createUserProject({
      username: user,
      projectName,
      gitlabPath,
      gitlabToken: body.gitlabToken,
      gitlabHost: body.gitlabHost || normalizeGitlabHost(),
      localPath: body.localPath?.trim() || defaultLocalPath(user, projectName),
      mainBranch: body.mainBranch,
      workingBranch: body.workingBranch,
      defaultCommitMode:
        body.defaultCommitMode === "manual" ? "manual" : "auto",
      allowedMilestones: normalizeAllowedMilestones(body.allowedMilestones),
      displayName: projectName,
      gitlabProjectId,
      isActive: body.activate !== false,
    });
    const memberships = await listPublicMemberships(user);
    return {
      project: publicProject(project),
      memberships,
      needsCloneConfirm: project.cloneStatus !== "ready",
      defaultLocalPath: project.localPath,
      usedDefaultPath,
    };
  } catch (err) {
    throw asAppError(err, 400);
  }
}

export type CloneProjectBody = {
  confirm?: boolean;
  gitlabToken?: string;
  localPath?: string;
};

/** Confirm + start background git clone for a project. */
export async function startProjectClone(
  username: string,
  projectIdRaw: string,
  body: CloneProjectBody,
) {
  const user = requireUser(username);
  const projectId = projectIdRaw.trim();
  if (!body.confirm) {
    throw new AppError(
      "Set confirm:true after UI confirmation prompt",
      400,
      "clone_confirm_required",
    );
  }
  let project = await getProject(projectId);
  if (!project || project.userId !== user.toLowerCase()) {
    throw new AppError("Project not found", 404);
  }
  if (body.gitlabToken?.trim() || body.localPath?.trim()) {
    project = await updateProjectFields(projectId, {
      ...(body.gitlabToken?.trim()
        ? { gitlabToken: body.gitlabToken.trim() }
        : {}),
      ...(body.localPath?.trim() ? { localPath: body.localPath.trim() } : {}),
    });
  }
  const secrets = await getUserSecrets(user, projectId);
  const token = secrets?.gitlabToken;
  if (!token) {
    throw new AppError("Project GitLab PAT required before clone", 400);
  }
  if (await isGitRepo(project.localPath)) {
    await updateProjectFields(projectId, {
      cloneStatus: "ready",
      cloneError: null,
    });
    return {
      ok: true,
      alreadyCloned: true,
      project: publicProject(await getProject(projectId)),
    };
  }
  if (project.cloneStatus === "cloning") {
    return { ok: true, cloning: true, project: publicProject(project) };
  }

  await updateProjectFields(projectId, {
    cloneStatus: "cloning",
    cloneError: null,
  });

  const cloneUrl = buildOauthCloneUrl(
    project.gitlabHost,
    token,
    project.gitlabPath,
  );
  const localPath = project.localPath;

  // Background clone — do not block HTTP
  void (async () => {
    try {
      await runGitClone({ cloneUrl, localPath });
      await updateProjectFields(projectId, {
        cloneStatus: "ready",
        cloneError: null,
      });
      logger.info("Project clone ready", { projectId, localPath });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await updateProjectFields(projectId, {
        cloneStatus: "failed",
        cloneError: msg,
      });
      logger.error("Project clone failed", { projectId, err: msg });
    }
  })();

  return {
    ok: true,
    cloning: true,
    project: publicProject(await getProject(projectId)),
  };
}

export async function getProjectCloneStatus(
  username: string,
  projectIdRaw: string,
) {
  const user = requireUser(username);
  const projectId = projectIdRaw.trim();
  const project = await getProject(projectId);
  if (!project || project.userId !== user.toLowerCase()) {
    throw new AppError("Project not found", 404);
  }
  const ready = await assertProjectCloneReady(projectId);
  return {
    project: publicProject(project),
    ...ready,
  };
}

export async function activateUserProject(
  username: string,
  projectIdRaw: string,
) {
  const user = requireUser(username);
  try {
    const project = await activateProject(user, projectIdRaw.trim());
    const memberships = await listPublicMemberships(user);
    return { project: publicProject(project), memberships };
  } catch (err) {
    throw asAppError(err, 400);
  }
}

export async function removeUserProject(username: string, projectIdRaw: string) {
  const user = requireUser(username);
  try {
    await deleteUserProject(user, projectIdRaw.trim());
    const memberships = await listPublicMemberships(user);
    return { ok: true, memberships };
  } catch (err) {
    throw asAppError(err, 400);
  }
}

export type JoinProjectBody = {
  gitlabPath?: string;
  repoPath?: string;
  baseBranch?: string;
  workBranch?: string;
  displayName?: string;
  gitlabToken?: string;
  projectName?: string;
  gitlabHost?: string;
};

/** Legacy join — works when the path already exists; prefer create + clone. */
export async function joinProject(username: string, body: JoinProjectBody) {
  const user = requireUser(username);
  const gitlabPath = body.gitlabPath?.trim();
  const repoPath = body.repoPath?.trim();
  if (!gitlabPath || !repoPath) {
    throw new AppError("gitlabPath and repoPath required", 400);
  }
  try {
    await access(repoPath, constants.R_OK);
  } catch {
    throw new AppError(`repoPath not readable: ${repoPath}`, 400);
  }

  const secrets = await getUserSecrets(user);
  const token = body.gitlabToken?.trim() || secrets?.gitlabToken;
  if (!token) {
    throw new AppError("gitlabToken required on body or project", 400);
  }

  const gl = await fetchGitlabProject(gitlabPath, token);
  const projectName =
    body.projectName?.trim() || gl.pathWithNamespace.split("/").pop() || "repo";
  const project = await upsertProject({
    gitlabPath: gl.pathWithNamespace,
    repoPath,
    displayName: body.displayName || gl.name,
    gitlabProjectId: gl.id,
    createdByUsername: user,
    userId: user,
    projectName,
    gitlabHost: body.gitlabHost,
    gitlabToken: token,
    mainBranch: body.baseBranch,
    workingBranch: body.workBranch,
  });
  await updateProjectFields(project.id, {
    cloneStatus: "ready",
    cloneError: null,
    isActive: true,
    mainBranch: body.baseBranch || "",
    workingBranch: body.workBranch || "",
  });
  const memberships = await listPublicMemberships(user);
  return {
    project: publicProject(await getProject(project.id)),
    membership: memberships.find((m) => m.projectId === project.id),
    memberships,
  };
}

export type UpdateProjectBody = {
  baseBranch?: string;
  workBranch?: string;
  repoPath?: string;
  localPath?: string;
  gitlabToken?: string;
  gitlabHost?: string;
  gitlabPath?: string;
  displayName?: string;
  /** UI “Flow project name” — also renames local folder when possible */
  projectName?: string;
  /** Default Auto/Manual commit for new jobs in this project */
  defaultCommitMode?: "manual" | "auto";
  /** Milestone titles allowed in Workbench; empty clears restriction */
  allowedMilestones?: string[];
};

/** Update branches / path / token / Flow name (+ rename folder) for owned project */
export async function updateOwnedProject(
  username: string,
  projectIdRaw: string,
  body: UpdateProjectBody,
) {
  const user = requireUser(username);
  const projectId = projectIdRaw.trim();
  if (!projectId) throw new AppError("projectId required", 400);
  const membership = await getMembership(user, projectId);
  if (!membership) {
    throw new AppError("Not a member of this project", 404);
  }
  const existingProject = await getProject(projectId);
  if (!existingProject) {
    throw new AppError("Project not found", 404);
  }

  const requestedName =
    body.projectName?.trim() || body.displayName?.trim() || undefined;

  let localPath = body.localPath?.trim() || body.repoPath?.trim();
  let folderRenamed = false;

  try {
    if (requestedName && requestedName !== existingProject.projectName) {
      const moved = await renameProjectLocalFolder({
        username: user,
        oldProjectName: existingProject.projectName,
        newProjectName: requestedName,
        currentLocalPath:
          existingProject.localPath || existingProject.repoPath || "",
      });
      localPath = moved.localPath;
      folderRenamed = moved.renamed;
    } else if (localPath) {
      try {
        await access(localPath, constants.R_OK);
      } catch {
        // allow setting path before clone
      }
    }

    const project = await updateProjectFields(projectId, {
      ...(localPath ? { localPath } : {}),
      ...(Object.prototype.hasOwnProperty.call(body, "baseBranch")
        ? { mainBranch: body.baseBranch ?? "" }
        : {}),
      ...(Object.prototype.hasOwnProperty.call(body, "workBranch")
        ? { workingBranch: body.workBranch ?? "" }
        : {}),
      ...(body.defaultCommitMode === "manual" ||
      body.defaultCommitMode === "auto"
        ? { defaultCommitMode: body.defaultCommitMode }
        : {}),
      ...(Object.prototype.hasOwnProperty.call(body, "allowedMilestones")
        ? {
            allowedMilestones: normalizeAllowedMilestones(
              body.allowedMilestones ?? [],
            ),
          }
        : {}),
      ...(body.gitlabToken?.trim()
        ? { gitlabToken: body.gitlabToken.trim() }
        : {}),
      ...(body.gitlabHost?.trim() ? { gitlabHost: body.gitlabHost } : {}),
      ...(body.gitlabPath?.trim() ? { gitlabPath: body.gitlabPath } : {}),
      ...(requestedName
        ? {
            projectName: requestedName,
            displayName: body.displayName?.trim() || requestedName,
          }
        : {}),
    });
    const memberships = await listPublicMemberships(user);
    return {
      membership: memberships.find((m) => m.projectId === projectId),
      project: publicProject(project),
      memberships,
      folderRenamed,
    };
  } catch (err) {
    throw asAppError(err, 400);
  }
}

/** GitLab projects accessible with the active project PAT (or any project token). */
export async function listMyGitlabProjectsForUser(
  username: string,
  projectId?: string,
) {
  const user = requireUser(username);
  const secrets = await getUserSecrets(user, projectId || undefined);
  if (!secrets?.gitlabToken) {
    throw new AppError(
      "Add GitLab PAT on the project (Settings → Project)",
      401,
    );
  }
  try {
    const projects = await listMyGitlabProjects(secrets.gitlabToken);
    return { projects };
  } catch (err) {
    throw asAppError(err, 400);
  }
}

/** Branches: GitLab remote + local (if repoPath given) */
export async function listProjectBranches(opts: {
  username: string;
  gitlabPath?: string;
  repoPath?: string;
  projectId?: string;
}) {
  const user = requireUser(opts.username);
  const gitlabPath = (opts.gitlabPath || "").trim();
  const repoPath = (opts.repoPath || "").trim();
  if (!gitlabPath) throw new AppError("gitlabPath required", 400);
  const secrets = await getUserSecrets(user, opts.projectId || undefined);
  if (!secrets?.gitlabToken) {
    throw new AppError(
      "Add GitLab PAT on the project (Settings → Project)",
      401,
    );
  }
  try {
    const remote = await listGitlabBranches(gitlabPath, secrets.gitlabToken);
    let local: string[] = [];
    if (repoPath) {
      try {
        await access(repoPath, constants.R_OK);
        const { stdout } = await execFileAsync(
          "git",
          ["for-each-ref", "--format=%(refname:short)", "refs/heads"],
          { cwd: repoPath, maxBuffer: 2 * 1024 * 1024 },
        );
        local = stdout
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean);
      } catch {
        local = [];
      }
    }
    return {
      remote,
      local,
      defaultBranch: remote.find((b) => b.default)?.name ?? null,
    };
  } catch (err) {
    throw asAppError(err, 400);
  }
}

/** Preview GitLab projects/branches/milestones with a raw PAT (wizard, before project saved). */
export async function previewGitlab(
  username: string,
  body: { gitlabToken?: string; gitlabPath?: string },
) {
  requireUser(username);
  const token = body.gitlabToken?.trim();
  if (!token) throw new AppError("gitlabToken required", 400);
  try {
    await verifyGitlabTokenUser(token);
    const projects = await listMyGitlabProjects(token);
    let branches: Array<{ name: string; default?: boolean }> = [];
    let defaultBranch: string | null = null;
    let milestones: string[] = [];
    const gitlabPath = body.gitlabPath?.trim();
    if (gitlabPath) {
      branches = await listGitlabBranches(gitlabPath, token);
      defaultBranch = branches.find((b) => b.default)?.name ?? null;
      const ms = await listProjectMilestones(gitlabPath, token);
      milestones = [
        ...new Set(ms.map((m) => m.title.trim()).filter(Boolean)),
      ].sort((a, b) => a.localeCompare(b));
    }
    return { projects, branches, defaultBranch, milestones };
  } catch (err) {
    throw asAppError(err, 400);
  }
}

/** Milestone titles for an owned project (uses project PAT). */
export async function listOwnedProjectMilestones(
  username: string,
  projectIdRaw: string,
) {
  const user = requireUser(username);
  const projectId = projectIdRaw.trim();
  if (!projectId) throw new AppError("projectId required", 400);
  const project = await getProject(projectId);
  if (!project || project.userId !== user.toLowerCase()) {
    throw new AppError("Project not found", 404);
  }
  const secrets = await getUserSecrets(user, projectId);
  if (!secrets?.gitlabToken) {
    throw new AppError(
      "Add GitLab PAT on the project (Settings → Project)",
      401,
    );
  }
  try {
    const ms = await listProjectMilestones(
      project.gitlabPath,
      secrets.gitlabToken,
    );
    const milestones = [
      ...new Set(ms.map((m) => m.title.trim()).filter(Boolean)),
    ].sort((a, b) => a.localeCompare(b));
    return { milestones };
  } catch (err) {
    throw asAppError(err, 400);
  }
}
