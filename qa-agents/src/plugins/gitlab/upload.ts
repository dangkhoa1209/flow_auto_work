import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { getConfig } from "../../../../src/config.js";
import { logger } from "../../../../src/logger.js";
import { requireRuntimeContext } from "../../../../src/workspace/runtime.js";
import { resolveGitlabProjectPath } from "../../../../src/workspace/creds.js";
import { jobArtifactsDir } from "../../job-store.js";

export type GitlabUploadResult = {
  alt: string;
  url: string;
  markdown: string;
};

/**
 * Upload a local file to GitLab project uploads API.
 * POST /api/v4/projects/:id/uploads
 */
export async function uploadProjectFile(
  absolutePath: string,
  opts?: { projectIdOrPath?: number | string; filename?: string },
): Promise<GitlabUploadResult> {
  const config = getConfig();
  const token = requireRuntimeContext().gitlabToken;
  const project = encodeURIComponent(
    String(opts?.projectIdOrPath ?? resolveGitlabProjectPath()),
  );
  const filename = opts?.filename || basename(absolutePath);
  const bytes = await readFile(absolutePath);
  const form = new FormData();
  form.append(
    "file",
    new Blob([new Uint8Array(bytes)]),
    filename,
  );

  const url = `${config.GITLAB_BASE_URL.replace(/\/$/, "")}/api/v4/projects/${project}/uploads`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "PRIVATE-TOKEN": token,
    },
    body: form,
  });
  if (!res.ok) {
    const text = await res.text();
    logger.warn("GitLab upload failed", { status: res.status, detail: text.slice(0, 300) });
    throw new Error(`GitLab upload failed (${res.status}): ${text.slice(0, 200)}`);
  }
  const data = (await res.json()) as {
    alt?: string;
    url?: string;
    markdown?: string;
  };
  if (!data.url && !data.markdown) {
    throw new Error("GitLab upload response missing url/markdown");
  }
  return {
    alt: data.alt || filename,
    url: data.url || "",
    markdown: data.markdown || `![${data.alt || filename}](${data.url})`,
  };
}

export async function uploadJobScreenshot(
  jobId: string,
  relativePath: string,
): Promise<GitlabUploadResult> {
  const abs = join(jobArtifactsDir(jobId), relativePath);
  return uploadProjectFile(abs, { filename: basename(relativePath) });
}
