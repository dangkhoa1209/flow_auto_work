/** Build feat/<iid>/<short-english-slug> from issue title. */
export function slugifyIssueTitle(title: string, maxLen = 40): string {
  const raw = (title || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLen)
    .replace(/-+$/g, "");
  return raw || "task";
}

export function autoWorkBranchName(issueIid: number, title: string): string {
  return `feat/${issueIid}/${slugifyIssueTitle(title)}`;
}
