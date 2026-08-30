import { getReviewDiff } from "../../plugins/git/diff.js";
import { logger } from "../../logger.js";
import {
  assertGitlabUploadHost,
  fetchGitlabUpload,
} from "../../plugins/gitlab/uploads.js";
import { verifyAccessToken } from "../../auth/tokens.js";
import { withWorkspaceContext } from "../../workspace/context.js";
import { requireRuntimeContext } from "../../workspace/runtime.js";
import { AppError } from "../../utils/AppError.js";

export async function getDiffPayload(issueIid?: number) {
  const diff = await getReviewDiff({
    issueIid: issueIid !== undefined ? Number(issueIid) : undefined,
  });
  return { diff };
}

export type ProxyUploadOpts = {
  rawUrl: string;
  username: string;
  projectId: string;
  accessTokenQuery?: string;
};

/** Returns binary payload for Express to stream. */
export async function proxyGitlabUpload(opts: ProxyUploadOpts): Promise<{
  buffer: ArrayBuffer;
  contentType: string;
}> {
  const raw = opts.rawUrl.trim();
  if (!raw) throw new AppError("u required", 400);

  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    throw new AppError("invalid u", 400);
  }

  const hostErr = assertGitlabUploadHost(target);
  if (hostErr === "bad GITLAB_BASE_URL") {
    throw new AppError(hostErr, 500);
  }
  if (hostErr) throw new AppError(hostErr, 403);

  const username = opts.username.trim().replace(/^@/, "");
  const projectId = opts.projectId.trim();
  if (!username || !projectId) {
    throw new AppError("user + project required", 401);
  }

  const accessQ = opts.accessTokenQuery?.trim();
  if (accessQ) {
    try {
      const sub = verifyAccessToken(accessQ).sub;
      if (sub !== username.toLowerCase()) {
        throw new AppError("token user mismatch", 403);
      }
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw new AppError("access token expired", 401);
    }
  }

  try {
    return await withWorkspaceContext(username, projectId, async () => {
      const token = requireRuntimeContext().gitlabToken;
      const result = await fetchGitlabUpload(target, token);
      if (!result.ok) {
        logger.warn("GitLab upload proxy failed", {
          status: result.status,
          path: target.pathname,
          detail: result.detail.slice(0, 200),
        });
        throw new AppError(
          result.detail.slice(0, 180) || `gitlab ${result.status}`,
          result.status >= 400 && result.status < 600 ? result.status : 404,
        );
      }
      const upstream = result.response;
      const contentType =
        upstream.headers.get("content-type") || "application/octet-stream";
      const buffer = await upstream.arrayBuffer();
      return { buffer, contentType };
    });
  } catch (err) {
    if (err instanceof AppError) throw err;
    logger.warn("GitLab upload proxy error", { err: String(err) });
    throw new AppError(
      err instanceof Error ? err.message : String(err),
      401,
    );
  }
}
