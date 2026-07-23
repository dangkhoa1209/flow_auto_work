import { Hono } from "hono";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import {
  fetchGitlabProject,
  listGitlabBranches,
  listMyGitlabProjects,
  verifyGitlabTokenUser,
} from "../gitlab/client.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
import {
  activateProject,
  createUserProject,
  deleteUserProject,
  getMembership,
  getProject,
  getUserByUsername,
  getUserSecrets,
  listMembershipsForUser,
  updateProjectFields,
  upsertProject,
  upsertUserLogin,
  clearCursorApiKey,
  updateUserPreferences,
} from "./store.js";
import { toPublicUser, defaultLocalPath, normalizeGitlabHost } from "./types.js";
import { assertProjectCloneReady, resolveRuntimeContext } from "./resolve.js";
import { runWithRuntimeContext } from "./runtime.js";
import { getConfig } from "../config.js";
import { Cursor } from "@cursor/sdk";
import { verifyAccessToken } from "../auth/tokens.js";
import { verifyPassword } from "../auth/password.js";
import {
  consumeRefreshSession,
  revokeAllRefreshSessions,
  revokeRefreshSession,
  saveRefreshSession,
} from "../auth/sessions.js";
import {
  newTokenPair,
  verifyRefreshToken,
  REFRESH_TTL_SEC,
} from "../auth/tokens.js";
import { buildOauthCloneUrl, isGitRepo, runGitClone } from "./clone.js";
import { logger } from "../logger.js";

type Req = {
  req: {
    header: (n: string) => string | undefined;
    query: (n: string) => string | undefined;
  };
};

/** Resolve username from Bearer access token, else X-Flow-User (legacy). */
function headerUser(c: Req): string {
  const bearer = (c.req.header("Authorization") || "").trim();
  if (bearer.toLowerCase().startsWith("bearer ")) {
    const token = bearer.slice(7).trim();
    if (token) {
      try {
        return verifyAccessToken(token).sub;
      } catch {
        /* fall through */
      }
    }
  }
  const qAccess = (c.req.query("access_token") || "").trim();
  if (qAccess) {
    try {
      return verifyAccessToken(qAccess).sub;
    } catch {
      /* fall through */
    }
  }
  return (c.req.header("X-Flow-User") || "").trim().replace(/^@/, "");
}

function headerProject(c: {
  req: {
    header: (n: string) => string | undefined;
    query?: (n: string) => string | undefined;
  };
}) {
  return (
    (c.req.header("X-Flow-Project") || "").trim() ||
    (c.req.query?.("project") || "").trim()
  );
}

async function issueAuthTokens(username: string) {
  const pair = newTokenPair(username);
  await saveRefreshSession({
    jti: pair.refresh.jti,
    username,
    rawToken: pair.refresh.token,
    expiresAt: pair.refresh.expiresAt,
  });
  return {
    accessToken: pair.access.token,
    refreshToken: pair.refresh.token,
    expiresIn: pair.access.expiresIn,
    accessExpiresAt: pair.access.expiresAt,
    refreshExpiresIn: REFRESH_TTL_SEC,
    tokenType: "Bearer" as const,
  };
}

function publicProject(project: Awaited<ReturnType<typeof getProject>>) {
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
    isActive: project.isActive,
    cloneStatus: project.cloneStatus,
    cloneError: project.cloneError ?? null,
    hasGitlabToken: Boolean(project.gitlabTokenEnc),
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
}

function sanitizeMembership(m: {
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

async function listPublicMemberships(username: string) {
  return (await listMembershipsForUser(username)).map(sanitizeMembership);
}

export function createWorkspaceRoutes() {
  const ws = new Hono();

  /** Public hints for login UI (no secrets) */
  ws.get("/auth/bootstrap", async (c) => {
    const config = getConfig();
    const gitlabBaseUrl = config.GITLAB_BASE_URL.replace(/\/$/, "");
    return c.json({
      gitlabBaseUrl,
      gitlabPatUrl: `${gitlabBaseUrl}/-/user_settings/personal_access_tokens`,
      cursorApiKeyUrl: "https://cursor.com/dashboard?tab=integrations",
      defaultCursorModel: "auto",
      authMode: "password",
      bypassEnabled: Boolean(config.AUTH_BYPASS_PASSWORD?.trim()),
    });
  });

  /** Resolve username from a pasted GitLab PAT (not stored). */
  ws.post("/auth/resolve-token", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      gitlabToken?: string;
    };
    const token = body.gitlabToken?.trim();
    if (!token) return c.json({ error: "gitlabToken required" }, 400);
    try {
      const profile = await verifyGitlabTokenUser(token);
      return c.json({
        username: profile.username,
        name: profile.name ?? null,
        id: profile.id,
      });
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        400,
      );
    }
  });

  /**
   * Register new username + password, then issue tokens (same shape as login).
   */
  ws.post("/auth/register", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      username?: string;
      password?: string;
      displayName?: string;
    };
    const username = (body.username || "").trim().replace(/^@/, "");
    const password = body.password ?? "";
    const displayName = body.displayName?.trim();

    if (!username) {
      return c.json({ error: "username required" }, 400);
    }
    if (!/^[a-zA-Z0-9._-]{3,32}$/.test(username)) {
      return c.json(
        {
          error:
            "Username 3–32 ký tự: chữ, số, chấm, gạch dưới, gạch ngang",
        },
        400,
      );
    }
    if (password.length < 6) {
      return c.json({ error: "Password tối thiểu 6 ký tự" }, 400);
    }

    const existing = await getUserByUsername(username);
    if (existing) {
      return c.json({ error: "Username đã tồn tại" }, 409);
    }

    const { createOrUpdateUserPassword } = await import("./store.js");
    const user = await createOrUpdateUserPassword({
      username,
      password,
      displayName: displayName || username,
    });
    const memberships = await listPublicMemberships(username);
    const tokens = await issueAuthTokens(username);
    return c.json({
      user,
      memberships,
      activeProjectId: memberships[0]?.projectId ?? null,
      ...tokens,
    });
  });

  /**
   * Login with username + password.
   * If AUTH_BYPASS_PASSWORD is set and matches, skip passwordHash check.
   */
  ws.post("/auth/login", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      username?: string;
      password?: string;
      gitlabUsername?: string;
      /** Legacy fields ignored for auth; use project settings for PAT */
      gitlabToken?: string;
      cursorApiKey?: string;
      displayName?: string;
    };
    const username = (
      body.username ||
      body.gitlabUsername ||
      ""
    )
      .trim()
      .replace(/^@/, "");
    const password = body.password ?? "";
    if (!username) {
      return c.json({ error: "username required" }, 400);
    }
    if (!password) {
      return c.json({ error: "password required" }, 400);
    }

    const config = getConfig();
    const bypass = config.AUTH_BYPASS_PASSWORD?.trim();
    const existing = await getUserByUsername(username);
    if (!existing) {
      return c.json(
        {
          error:
            "User not found. Chưa có đăng ký — dùng tài khoản đã seed hoặc nhờ admin tạo user.",
        },
        401,
      );
    }

    const bypassOk = Boolean(bypass && password === bypass);
    if (!bypassOk) {
      if (!existing.passwordHash) {
        return c.json(
          {
            error:
              "Tài khoản này chưa có password (login GitLab cũ). Dùng user khoadev hoặc nhờ admin set password.",
          },
          401,
        );
      }
      const ok = await verifyPassword(password, existing.passwordHash);
      if (!ok) return c.json({ error: "Invalid username or password" }, 401);
    }

    if (body.cursorApiKey?.trim()) {
      await upsertUserLogin({
        gitlabUsername: username,
        cursorApiKey: body.cursorApiKey,
        displayName: body.displayName,
      });
    }

    const user = toPublicUser(
      (await getUserByUsername(username)) || existing,
    );
    const memberships = await listPublicMemberships(username);
    const tokens = await issueAuthTokens(username);
    const active =
      memberships.find((m) => (m.project as { isActive?: boolean } | null)?.isActive)
        ?.projectId ||
      memberships[0]?.projectId ||
      null;
    return c.json({
      user,
      memberships,
      activeProjectId: active,
      bypassUsed: bypassOk,
      ...tokens,
    });
  });

  /** Exchange refresh token → new access (+ rotated refresh). */
  ws.post("/auth/refresh", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      refreshToken?: string;
    };
    const raw = body.refreshToken?.trim();
    if (!raw) return c.json({ error: "refreshToken required" }, 400);
    try {
      const claims = verifyRefreshToken(raw);
      const ok = await consumeRefreshSession({
        jti: claims.jti,
        username: claims.sub,
        rawToken: raw,
      });
      if (!ok) {
        return c.json(
          {
            error: "Phiên đăng nhập hết hạn hoặc không hợp lệ — vui lòng đăng nhập lại",
            code: "SESSION_EXPIRED",
          },
          401,
        );
      }
      const user = await getUserByUsername(claims.sub);
      if (!user) {
        await revokeRefreshSession(claims.jti);
        return c.json({ error: "User not found", code: "SESSION_EXPIRED" }, 401);
      }
      // Issue new pair first, then revoke old (avoid locking user out if issue fails)
      const tokens = await issueAuthTokens(claims.sub);
      await revokeRefreshSession(claims.jti);
      return c.json({
        user: toPublicUser(user),
        ...tokens,
      });
    } catch (err) {
      return c.json(
        {
          error: err instanceof Error ? err.message : "Invalid refresh token",
          code: "SESSION_EXPIRED",
        },
        401,
      );
    }
  });

  /** Revoke refresh session(s). */
  ws.post("/auth/logout", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      refreshToken?: string;
      all?: boolean;
    };
    const username = headerUser(c);
    if (body.all && username) {
      await revokeAllRefreshSessions(username);
      return c.json({ ok: true, revoked: "all" });
    }
    const raw = body.refreshToken?.trim();
    if (raw) {
      try {
        const claims = verifyRefreshToken(raw);
        await revokeRefreshSession(claims.jti);
      } catch {
        /* already invalid */
      }
    }
    return c.json({ ok: true });
  });

  ws.get("/me", async (c) => {
    const username = headerUser(c);
    if (!username) return c.json({ error: "X-Flow-User required" }, 401);
    const raw = await getUserByUsername(username);
    if (!raw) return c.json({ error: "User not found — login first" }, 404);
    const memberships = await listPublicMemberships(username);
    return c.json({ user: toPublicUser(raw), memberships });
  });

  /** Update secrets only (encrypted). Never echoes tokens back. */
  ws.put("/me/secrets", async (c) => {
    const username = headerUser(c);
    if (!username) return c.json({ error: "X-Flow-User required" }, 401);
    const body = (await c.req.json().catch(() => ({}))) as {
      gitlabToken?: string;
      cursorApiKey?: string;
      cursorModel?: string;
    };
    if (
      !body.gitlabToken?.trim() &&
      !body.cursorApiKey?.trim() &&
      body.cursorModel === undefined
    ) {
      return c.json(
        { error: "Provide cursorApiKey and/or cursorModel (GitLab PAT → project settings)" },
        400,
      );
    }
    // GitLab PAT on user is legacy; prefer project token. Still allow optional store.
    if (body.gitlabToken?.trim()) {
      try {
        await verifyGitlabTokenUser(body.gitlabToken.trim());
      } catch (err) {
        return c.json(
          { error: err instanceof Error ? err.message : String(err) },
          400,
        );
      }
    }
    const user = await upsertUserLogin({
      gitlabUsername: username,
      gitlabToken: body.gitlabToken,
      cursorApiKey: body.cursorApiKey,
      cursorModel: body.cursorModel,
    });
    return c.json({ user, ok: true });
  });

  /** Preferences (non-secret): Cursor model, etc. */
  ws.put("/me/preferences", async (c) => {
    const username = headerUser(c);
    if (!username) return c.json({ error: "X-Flow-User required" }, 401);
    const body = (await c.req.json().catch(() => ({}))) as {
      cursorModel?: string;
    };
    if (body.cursorModel === undefined) {
      return c.json({ error: "cursorModel required" }, 400);
    }
    try {
      const user = await updateUserPreferences({
        gitlabUsername: username,
        cursorModel: body.cursorModel,
      });
      return c.json({ user, ok: true });
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        404,
      );
    }
  });

  /**
   * List Cursor models for the logged-in user's API key.
   * Always includes `auto`. Falls back to static list if SDK list fails / no key.
   */
  ws.get("/me/cursor-models", async (c) => {
    const username = headerUser(c);
    if (!username) return c.json({ error: "X-Flow-User required" }, 401);
    const config = getConfig();
    const fallback = [
      { id: "auto", displayName: "Auto (server picks)" },
      { id: "composer-2.5", displayName: "Composer 2.5" },
    ];
    const secrets = await getUserSecrets(username);
    const apiKey =
      secrets?.cursorApiKey?.trim() || config.CURSOR_API_KEY?.trim() || "";
    if (!apiKey) {
      return c.json({
        models: fallback,
        source: "fallback",
        selected: (await getUserByUsername(username))?.cursorModel || "auto",
      });
    }
    try {
      const listed = await Cursor.models.list({ apiKey });
      const raw = Array.isArray(listed)
        ? listed
        : Array.isArray((listed as { models?: unknown }).models)
          ? (listed as { models: unknown[] }).models
          : [];
      const models: { id: string; displayName: string }[] = [
        { id: "auto", displayName: "Auto (server picks)" },
      ];
      const seen = new Set(["auto"]);
      for (const item of raw) {
        const m = item as { id?: string; displayName?: string; name?: string };
        const id = (m.id || "").trim();
        if (!id || seen.has(id)) continue;
        seen.add(id);
        models.push({
          id,
          displayName: m.displayName || m.name || id,
        });
      }
      const user = await getUserByUsername(username);
      return c.json({
        models,
        source: "cursor",
        selected: user?.cursorModel?.trim() || "auto",
      });
    } catch (err) {
      const user = await getUserByUsername(username);
      return c.json({
        models: fallback,
        source: "fallback",
        selected: user?.cursorModel?.trim() || "auto",
        warning: err instanceof Error ? err.message : String(err),
      });
    }
  });

  /** Clear Cursor API key */
  ws.delete("/me/cursor-key", async (c) => {
    const username = headerUser(c);
    if (!username) return c.json({ error: "X-Flow-User required" }, 401);
    try {
      const user = await clearCursorApiKey(username);
      return c.json({ user, ok: true });
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        404,
      );
    }
  });

  /** GitLab projects accessible with the active project PAT (or any project token). */
  ws.get("/gitlab/my-projects", async (c) => {
    const username = headerUser(c);
    if (!username) return c.json({ error: "X-Flow-User required" }, 401);
    const projectId = headerProject(c);
    const secrets = await getUserSecrets(username, projectId || undefined);
    if (!secrets?.gitlabToken) {
      return c.json(
        { error: "Add GitLab PAT on the project (Settings → Project)" },
        401,
      );
    }
    try {
      const projects = await listMyGitlabProjects(secrets.gitlabToken);
      return c.json({ projects });
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        400,
      );
    }
  });

  /** Branches: GitLab remote + local (if repoPath given) */
  ws.get("/gitlab/branches", async (c) => {
    const username = headerUser(c);
    if (!username) return c.json({ error: "X-Flow-User required" }, 401);
    const gitlabPath = (c.req.query("gitlabPath") || "").trim();
    const repoPath = (c.req.query("repoPath") || "").trim();
    const projectId =
      (c.req.query("projectId") || "").trim() || headerProject(c);
    if (!gitlabPath) return c.json({ error: "gitlabPath required" }, 400);
    const secrets = await getUserSecrets(username, projectId || undefined);
    if (!secrets?.gitlabToken) {
      return c.json(
        { error: "Add GitLab PAT on the project (Settings → Project)" },
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
      return c.json({
        remote,
        local,
        defaultBranch: remote.find((b) => b.default)?.name ?? null,
      });
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        400,
      );
    }
  });

  /** Preview GitLab projects/branches with a raw PAT (wizard, before project saved). */
  ws.post("/gitlab/preview", async (c) => {
    const username = headerUser(c);
    if (!username) return c.json({ error: "X-Flow-User required" }, 401);
    const body = (await c.req.json().catch(() => ({}))) as {
      gitlabToken?: string;
      gitlabPath?: string;
    };
    const token = body.gitlabToken?.trim();
    if (!token) return c.json({ error: "gitlabToken required" }, 400);
    try {
      await verifyGitlabTokenUser(token);
      const projects = await listMyGitlabProjects(token);
      let branches: Array<{ name: string; default?: boolean }> = [];
      let defaultBranch: string | null = null;
      const gitlabPath = body.gitlabPath?.trim();
      if (gitlabPath) {
        branches = await listGitlabBranches(gitlabPath, token);
        defaultBranch = branches.find((b) => b.default)?.name ?? null;
      }
      return c.json({ projects, branches, defaultBranch });
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        400,
      );
    }
  });

  /** Resolve default clone path without creating a project. */
  ws.get("/projects/default-path", async (c) => {
    const username = headerUser(c);
    if (!username) return c.json({ error: "X-Flow-User required" }, 401);
    const projectName = (c.req.query("projectName") || "project").trim();
    return c.json({
      localPath: defaultLocalPath(username, projectName),
    });
  });

  /**
   * Create a user-owned project (PAT on project). Does not clone until /clone.
   */
  ws.post("/projects", async (c) => {
    const username = headerUser(c);
    if (!username) return c.json({ error: "X-Flow-User required" }, 401);
    const body = (await c.req.json().catch(() => ({}))) as {
      projectName?: string;
      gitlabPath?: string;
      gitlabToken?: string;
      gitlabHost?: string;
      localPath?: string;
      mainBranch?: string;
      workingBranch?: string;
      displayName?: string;
      activate?: boolean;
    };
    const projectName = body.projectName?.trim();
    const gitlabPath = body.gitlabPath?.trim();
    if (!projectName || !gitlabPath) {
      return c.json({ error: "projectName and gitlabPath required" }, 400);
    }
    try {
      let gitlabProjectId: number | undefined;
      if (body.gitlabToken?.trim()) {
        try {
          const gl = await fetchGitlabProject(
            gitlabPath,
            body.gitlabToken.trim(),
          );
          gitlabProjectId = gl.id;
        } catch (err) {
          logger.warn("Could not resolve GitLab project id on create", {
            err: String(err),
          });
        }
      }
      const usedDefaultPath = !body.localPath?.trim();
      const project = await createUserProject({
        username,
        projectName,
        gitlabPath,
        gitlabToken: body.gitlabToken,
        gitlabHost: body.gitlabHost || normalizeGitlabHost(),
        localPath:
          body.localPath?.trim() ||
          defaultLocalPath(username, projectName),
        mainBranch: body.mainBranch,
        workingBranch: body.workingBranch,
        displayName: body.displayName,
        gitlabProjectId,
        isActive: body.activate !== false,
      });
      const memberships = await listPublicMemberships(username);
      return c.json({
        project: publicProject(project),
        memberships,
        needsCloneConfirm: project.cloneStatus !== "ready",
        defaultLocalPath: project.localPath,
        usedDefaultPath,
      });
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        400,
      );
    }
  });

  /** Confirm + start background git clone for a project. */
  ws.post("/projects/:projectId/clone", async (c) => {
    const username = headerUser(c);
    if (!username) return c.json({ error: "X-Flow-User required" }, 401);
    const projectId = decodeURIComponent(c.req.param("projectId") || "").trim();
    const body = (await c.req.json().catch(() => ({}))) as {
      confirm?: boolean;
      gitlabToken?: string;
      localPath?: string;
    };
    if (!body.confirm) {
      return c.json(
        {
          error: "Set confirm:true after UI confirmation prompt",
          hint: "Clone will run: git clone https://oauth2:***@host/group/repo.git localPath",
        },
        400,
      );
    }
    let project = await getProject(projectId);
    if (!project || project.userId !== username.toLowerCase()) {
      return c.json({ error: "Project not found" }, 404);
    }
    if (body.gitlabToken?.trim() || body.localPath?.trim()) {
      project = await updateProjectFields(projectId, {
        ...(body.gitlabToken?.trim()
          ? { gitlabToken: body.gitlabToken.trim() }
          : {}),
        ...(body.localPath?.trim() ? { localPath: body.localPath.trim() } : {}),
      });
    }
    const secrets = await getUserSecrets(username, projectId);
    const token = secrets?.gitlabToken;
    if (!token) {
      return c.json({ error: "Project GitLab PAT required before clone" }, 400);
    }
    if (await isGitRepo(project.localPath)) {
      await updateProjectFields(projectId, {
        cloneStatus: "ready",
        cloneError: null,
      });
      return c.json({
        ok: true,
        alreadyCloned: true,
        project: publicProject(await getProject(projectId)),
      });
    }
    if (project.cloneStatus === "cloning") {
      return c.json({ ok: true, cloning: true, project: publicProject(project) });
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

    return c.json({
      ok: true,
      cloning: true,
      project: publicProject(await getProject(projectId)),
    });
  });

  ws.get("/projects/:projectId/clone-status", async (c) => {
    const username = headerUser(c);
    if (!username) return c.json({ error: "X-Flow-User required" }, 401);
    const projectId = decodeURIComponent(c.req.param("projectId") || "").trim();
    const project = await getProject(projectId);
    if (!project || project.userId !== username.toLowerCase()) {
      return c.json({ error: "Project not found" }, 404);
    }
    const ready = await assertProjectCloneReady(projectId);
    return c.json({
      project: publicProject(project),
      ...ready,
    });
  });

  ws.post("/projects/:projectId/activate", async (c) => {
    const username = headerUser(c);
    if (!username) return c.json({ error: "X-Flow-User required" }, 401);
    const projectId = decodeURIComponent(c.req.param("projectId") || "").trim();
    try {
      const project = await activateProject(username, projectId);
      const memberships = await listPublicMemberships(username);
      return c.json({ project: publicProject(project), memberships });
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        400,
      );
    }
  });

  ws.delete("/projects/:projectId", async (c) => {
    const username = headerUser(c);
    if (!username) return c.json({ error: "X-Flow-User required" }, 401);
    const projectId = decodeURIComponent(c.req.param("projectId") || "").trim();
    try {
      await deleteUserProject(username, projectId);
      const memberships = await listPublicMemberships(username);
      return c.json({ ok: true, memberships });
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        400,
      );
    }
  });

  /**
   * Legacy join — still works if path already exists; prefer POST /projects + clone.
   */
  ws.post("/projects/join", async (c) => {
    const username = headerUser(c);
    if (!username) return c.json({ error: "X-Flow-User required" }, 401);
    const body = (await c.req.json().catch(() => ({}))) as {
      gitlabPath?: string;
      repoPath?: string;
      baseBranch?: string;
      workBranch?: string;
      displayName?: string;
      gitlabToken?: string;
      projectName?: string;
      gitlabHost?: string;
    };
    const gitlabPath = body.gitlabPath?.trim();
    const repoPath = body.repoPath?.trim();
    if (!gitlabPath || !repoPath) {
      return c.json({ error: "gitlabPath and repoPath required" }, 400);
    }
    try {
      await access(repoPath, constants.R_OK);
    } catch {
      return c.json({ error: `repoPath not readable: ${repoPath}` }, 400);
    }

    const secrets = await getUserSecrets(username);
    const token = body.gitlabToken?.trim() || secrets?.gitlabToken;
    if (!token) {
      return c.json({ error: "gitlabToken required on body or project" }, 400);
    }

    const gl = await fetchGitlabProject(gitlabPath, token);
    const projectName =
      body.projectName?.trim() || gl.pathWithNamespace.split("/").pop() || "repo";
    const project = await upsertProject({
      gitlabPath: gl.pathWithNamespace,
      repoPath,
      displayName: body.displayName || gl.name,
      gitlabProjectId: gl.id,
      createdByUsername: username,
      userId: username,
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
    const memberships = await listPublicMemberships(username);
    return c.json({
      project: publicProject(await getProject(project.id)),
      membership: memberships.find((m) => m.projectId === project.id),
      memberships,
    });
  });

  /** Update branches / path / token for owned project */
  ws.put("/me/projects/:projectId", async (c) => {
    const username = headerUser(c);
    if (!username) return c.json({ error: "X-Flow-User required" }, 401);
    const projectId = decodeURIComponent(c.req.param("projectId") || "").trim();
    if (!projectId) return c.json({ error: "projectId required" }, 400);
    const body = (await c.req.json().catch(() => ({}))) as {
      baseBranch?: string;
      workBranch?: string;
      repoPath?: string;
      localPath?: string;
      gitlabToken?: string;
      gitlabHost?: string;
      gitlabPath?: string;
    };
    const existing = await getMembership(username, projectId);
    if (!existing) {
      return c.json({ error: "Not a member of this project" }, 404);
    }
    const localPath = body.localPath?.trim() || body.repoPath?.trim();
    if (localPath) {
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
      ...(body.gitlabToken?.trim()
        ? { gitlabToken: body.gitlabToken.trim() }
        : {}),
      ...(body.gitlabHost?.trim() ? { gitlabHost: body.gitlabHost } : {}),
      ...(body.gitlabPath?.trim() ? { gitlabPath: body.gitlabPath } : {}),
    });
    const memberships = await listPublicMemberships(username);
    return c.json({
      membership: memberships.find((m) => m.projectId === projectId),
      project: publicProject(project),
      memberships,
    });
  });

  /**
   * Browse local directories on this machine (same host as repos).
   * Used by UI folder picker — browsers cannot expose absolute paths.
   */
  ws.get("/fs/browse", async (c) => {
    const username = headerUser(c);
    if (!username) return c.json({ error: "X-Flow-User required" }, 401);
    const raw = (c.req.query("path") || "").trim();
    try {
      const { browseDirectory } = await import("../fs/browse.js");
      const result = await browseDirectory(raw || undefined);
      return c.json(result);
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        400,
      );
    }
  });

  ws.get("/context", async (c) => {
    const username = headerUser(c);
    const projectId = headerProject(c);
    if (!username || !projectId) {
      return c.json({ error: "X-Flow-User and X-Flow-Project required" }, 401);
    }
    try {
      const ctx = await resolveRuntimeContext({
        gitlabUsername: username,
        projectId,
      });
      return c.json({
        gitlabUsername: ctx.gitlabUsername,
        projectId: ctx.projectId,
        gitlabPath: ctx.gitlabPath,
        repoPath: ctx.repoPath,
        baseBranch: ctx.baseBranch ?? null,
        workBranch: ctx.workBranch ?? null,
        hasSecrets: true,
      });
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        400,
      );
    }
  });

  return ws;
}

/** Run handler inside decrypted user/project runtime context. */
export async function withWorkspaceContext<T>(
  username: string,
  projectId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const ctx = await resolveRuntimeContext({
    gitlabUsername: username,
    projectId,
  });
  return runWithRuntimeContext(ctx, fn);
}

export { headerUser, headerProject };
