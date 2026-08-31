/** Build / resolve a forge issue URL for opening in a new tab. */
export function gitlabIssueUrl(opts: {
  url?: string | null;
  iid?: number | null;
  gitlabHost?: string | null;
  gitlabPath?: string | null;
  /** gitlab (default) | github */
  gitProvider?: string | null;
}): string | null {
  const direct = opts.url?.trim();
  if (direct) return direct;

  const iid = opts.iid;
  if (!iid || iid <= 0) return null;

  const path = (opts.gitlabPath || "").trim().replace(/^\/+|\/+$/g, "");
  if (!path) return null;

  const provider = opts.gitProvider === "github" ? "github" : "gitlab";
  let host = (
    opts.gitlabHost ||
    (provider === "github" ? "https://github.com" : "https://gitlab.com")
  )
    .trim()
    .replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(host)) host = `https://${host}`;

  if (provider === "github") {
    return `${host}/${path}/issues/${iid}`;
  }
  return `${host}/${path}/-/issues/${iid}`;
}
