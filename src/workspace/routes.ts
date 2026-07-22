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
  getMembership,
  getUserByUsername,
  getUserSecrets,
  listMembershipsForUser,
  upsertMembership,
  upsertProject,
  upsertUserLogin,
  clearCursorApiKey,
  updateUserPreferences,
} from "./store.js";
import { toPublicUser } from "./types.js";
import { resolveRuntimeContext } from "./resolve.js";
import { runWithRuntimeContext } from "./runtime.js";
import { getConfig } from "../config.js";
import { Cursor } from "@cursor/sdk";

function headerUser(c: { req: { header: (n: string) => string | undefined } }) {
  return (c.req.header("X-Flow-User") || "").trim().replace(/^@/, "");
}

function headerProject(c: {
  req: { header: (n: string) => string | undefined };
}) {
  return (c.req.header("X-Flow-Project") || "").trim();
}

export function createWorkspaceRoutes() {
  const ws = new Hono();

  /** Public hints for login UI (no secrets) */
  ws.get("/auth/bootstrap", async (c) => {
    const config = getConfig();
    const gitlabBaseUrl = config.GITLAB_BASE_URL.replace(/\/$/, "");
    return c.json({
      suggestedUsername: config.GITLAB_ASSIGNEE_USERNAME ?? null,
      gitlabBaseUrl,
      gitlabPatUrl: `${gitlabBaseUrl}/-/user_settings/personal_access_tokens`,
      cursorApiKeyUrl: "https://cursor.com/dashboard?tab=integrations",
      defaultCursorModel: "auto",
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
   * Login / register.
   * If username omitted but gitlabToken provided → resolve username from GitLab /user.
   * Tokens verified then stored encrypted (never returned).
   */
  ws.post("/auth/login", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      gitlabUsername?: string;
      gitlabToken?: string;
      cursorApiKey?: string;
      displayName?: string;
    };
    let username = (body.gitlabUsername || "").trim().replace(/^@/, "");
    let gitlabToken = body.gitlabToken?.trim();
    let cursorApiKey = body.cursorApiKey?.trim();

    if (!username && gitlabToken) {
      const profile = await verifyGitlabTokenUser(gitlabToken);
      username = profile.username;
      body.displayName = body.displayName || profile.name;
    }
    if (!username) {
      return c.json(
        { error: "gitlabUsername required (or paste GitLab PAT to auto-detect)" },
        400,
      );
    }

    const existing = await getUserByUsername(username);
    // First login: require GitLab PAT (Cursor key optional until Run)
    if (!existing?.gitlabTokenEnc && !gitlabToken) {
      return c.json({ error: "gitlabToken required" }, 400);
    }

    if (gitlabToken) {
      const profile = await verifyGitlabTokenUser(gitlabToken);
      if (profile.username.toLowerCase() !== username.toLowerCase()) {
        return c.json(
          {
            error: `Token belongs to @${profile.username}, not @${username}`,
          },
          400,
        );
      }
      body.displayName = body.displayName || profile.name;
    }

    const user = await upsertUserLogin({
      gitlabUsername: username,
      displayName: body.displayName,
      gitlabToken,
      cursorApiKey,
    });
    const memberships = await listMembershipsForUser(username);
    return c.json({
      user,
      memberships,
    });
  });

  ws.get("/me", async (c) => {
    const username = headerUser(c);
    if (!username) return c.json({ error: "X-Flow-User required" }, 401);
    const raw = await getUserByUsername(username);
    if (!raw) return c.json({ error: "User not found — login first" }, 404);
    const memberships = await listMembershipsForUser(username);
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
        { error: "Provide gitlabToken, cursorApiKey, and/or cursorModel" },
        400,
      );
    }
    if (body.gitlabToken?.trim()) {
      const profile = await verifyGitlabTokenUser(body.gitlabToken.trim());
      if (profile.username.toLowerCase() !== username.toLowerCase()) {
        return c.json(
          { error: `Token belongs to @${profile.username}` },
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

  /** GitLab projects the logged-in user can access */
  ws.get("/gitlab/my-projects", async (c) => {
    const username = headerUser(c);
    if (!username) return c.json({ error: "X-Flow-User required" }, 401);
    const secrets = await import("./store.js").then((m) =>
      m.getUserSecrets(username),
    );
    if (!secrets?.gitlabToken) {
      return c.json({ error: "Login with GitLab PAT first" }, 401);
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
    if (!gitlabPath) return c.json({ error: "gitlabPath required" }, 400);
    const secrets = await import("./store.js").then((m) =>
      m.getUserSecrets(username),
    );
    if (!secrets?.gitlabToken) {
      return c.json({ error: "Login with GitLab PAT first" }, 401);
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

  /**
   * Join (or create) a project — one user can join many.
   * Body: gitlabPath, repoPath (local), baseBranch?, workBranch?
   */
  ws.post("/projects/join", async (c) => {
    const username = headerUser(c);
    if (!username) return c.json({ error: "X-Flow-User required" }, 401);
    const rawUser = await getUserByUsername(username);
    if (!rawUser?.gitlabTokenEnc) {
      return c.json({ error: "Login with GitLab token first" }, 400);
    }
    const body = (await c.req.json().catch(() => ({}))) as {
      gitlabPath?: string;
      repoPath?: string;
      baseBranch?: string;
      workBranch?: string;
      displayName?: string;
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

    const secrets = await import("./store.js").then((m) =>
      m.getUserSecrets(username),
    );
    if (!secrets?.gitlabToken) return c.json({ error: "Missing GitLab token" }, 400);

    const gl = await fetchGitlabProject(gitlabPath, secrets.gitlabToken);
    const project = await upsertProject({
      gitlabPath: gl.pathWithNamespace,
      repoPath,
      displayName: body.displayName || gl.name,
      gitlabProjectId: gl.id,
      createdByUsername: username,
    });
    const membership = await upsertMembership({
      userId: username,
      projectId: project.id,
      baseBranch: body.baseBranch,
      workBranch: body.workBranch,
      role: "dev",
    });
    const memberships = await listMembershipsForUser(username);
    return c.json({ project, membership, memberships });
  });

  /** Update base/work branch (and optional local repo path) for a membership */
  ws.put("/me/projects/:projectId", async (c) => {
    const username = headerUser(c);
    if (!username) return c.json({ error: "X-Flow-User required" }, 401);
    const projectId = decodeURIComponent(c.req.param("projectId") || "").trim();
    if (!projectId) return c.json({ error: "projectId required" }, 400);
    const body = (await c.req.json().catch(() => ({}))) as {
      baseBranch?: string;
      workBranch?: string;
      repoPath?: string;
    };
    const existing = await getMembership(username, projectId);
    if (!existing) {
      return c.json({ error: "Not a member of this project" }, 404);
    }
    if (body.repoPath?.trim()) {
      try {
        await access(body.repoPath.trim(), constants.R_OK);
      } catch {
        return c.json({ error: `repoPath not readable` }, 400);
      }
      const project = await import("./store.js").then((m) =>
        m.getProject(projectId),
      );
      if (project) {
        await upsertProject({
          gitlabPath: project.gitlabPath,
          repoPath: body.repoPath.trim(),
          displayName: project.displayName,
          gitlabProjectId: project.gitlabProjectId,
          createdByUsername: project.createdByUsername,
        });
      }
    }
    // Always pass branch fields when present in body (incl. empty → clear)
    const membership = await upsertMembership({
      userId: username,
      projectId,
      ...(Object.prototype.hasOwnProperty.call(body, "baseBranch")
        ? { baseBranch: body.baseBranch ?? "" }
        : {}),
      ...(Object.prototype.hasOwnProperty.call(body, "workBranch")
        ? { workBranch: body.workBranch ?? "" }
        : {}),
    });
    const memberships = await listMembershipsForUser(username);
    return c.json({ membership, memberships });
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
