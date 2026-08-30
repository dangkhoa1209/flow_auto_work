/** Build / resolve a GitLab issue URL for opening in a new tab. */
export function gitlabIssueUrl(opts: {
  url?: string | null;
  iid?: number | null;
  gitlabHost?: string | null;
  gitlabPath?: string | null;
}): string | null {
  const direct = opts.url?.trim();
  if (direct) return direct;

  const iid = opts.iid;
  if (!iid || iid <= 0) return null;

  const path = (opts.gitlabPath || "").trim().replace(/^\/+|\/+$/g, "");
  if (!path) return null;

  let host = (opts.gitlabHost || "https://gitlab.com").trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(host)) host = `https://${host}`;

  return `${host}/${path}/-/issues/${iid}`;
}
