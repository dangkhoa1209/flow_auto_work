import { getConfig } from "../config.js";
import { logger } from "../logger.js";
import { fetchGitlabProject } from "./client.js";

const UPLOAD_UA = "flow-auto-work/1.0 (Node.js; GitLab upload proxy)";

function uploadAuthHeaders(token: string): Record<string, string> {
  return {
    "PRIVATE-TOKEN": token,
    Authorization: `Bearer ${token}`,
    Accept: "*/*",
    "User-Agent": UPLOAD_UA,
  };
}

/** `/ns/proj/uploads/secret/file` or `/-/project/:id/uploads/secret/file` */
export function parseUploadPath(pathname: string): {
  projectPath?: string;
  projectId?: string;
  secret: string;
  filename: string;
} | null {
  const classic = pathname.match(/^\/(.+)\/uploads\/([^/]+)\/(.+)$/i);
  if (!classic) return null;
  const head = classic[1];
  const secret = classic[2];
  const filename = classic[3];
  if (!secret || !filename) return null;

  const projectIdForm = head.match(/^-\/project\/(\d+)$/i);
  if (projectIdForm) {
    return { projectId: projectIdForm[1], secret, filename };
  }
  if (head.startsWith("-/")) return null;
  return { projectPath: head, secret, filename };
}

/**
 * Download markdown upload via REST API (avoids Cloudflare on web /uploads/ paths).
 * GET /api/v4/projects/:id/uploads/:secret/:filename
 */
export async function fetchGitlabUpload(
  target: URL,
  token: string,
): Promise<
  | { ok: true; response: Response }
  | { ok: false; status: number; detail: string }
> {
  const parsed = parseUploadPath(target.pathname);
  if (!parsed) {
    return {
      ok: false,
      status: 400,
      detail: "unrecognized upload path",
    };
  }

  let projectRef = parsed.projectId;
  if (!projectRef && parsed.projectPath) {
    try {
      const project = await fetchGitlabProject(parsed.projectPath, token);
      projectRef = String(project.id);
    } catch (err) {
      logger.warn("GitLab upload: project resolve failed", {
        projectPath: parsed.projectPath,
        err: String(err),
      });
      return {
        ok: false,
        status: 404,
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }
  if (!projectRef) {
    return { ok: false, status: 400, detail: "missing project id" };
  }

  const config = getConfig();
  const base = config.GITLAB_BASE_URL.replace(/\/$/, "");
  const apiUrl =
    `${base}/api/v4/projects/${encodeURIComponent(projectRef)}` +
    `/uploads/${encodeURIComponent(parsed.secret)}/${encodeURIComponent(parsed.filename)}`;

  const upstream = await fetch(apiUrl, {
    headers: uploadAuthHeaders(token),
    redirect: "follow",
  });

  if (upstream.ok) return { ok: true, response: upstream };

  const detail = await upstream.text().catch(() => "");
  logger.warn("GitLab upload API failed", {
    status: upstream.status,
    apiPath: `/projects/${projectRef}/uploads/${parsed.secret}/${parsed.filename}`,
    detail: detail.slice(0, 200),
  });
  return {
    ok: false,
    status: upstream.status,
    detail: detail.slice(0, 200) || `gitlab ${upstream.status}`,
  };
}

export function assertGitlabUploadHost(target: URL): string | null {
  const config = getConfig();
  const gitlabRoot = config.GITLAB_BASE_URL.replace(/\/$/, "");
  let gitlabHost: string;
  try {
    gitlabHost = new URL(gitlabRoot).host;
  } catch {
    return "bad GITLAB_BASE_URL";
  }
  if (target.host !== gitlabHost) return "host not allowed";
  if (!/\/uploads\//i.test(target.pathname)) {
    return "only /uploads/ paths allowed";
  }
  return null;
}
