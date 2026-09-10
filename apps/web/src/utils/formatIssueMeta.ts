import { formatChatTime } from "./formatChatTime";

/** Fields used to build the compact issue meta line on /work. */
export type IssueMetaSource = {
  state?: string;
  author?: string;
  assignees?: Array<{ username: string; name?: string }>;
  taskCompletion?: { count: number; completedCount: number };
  milestone?: { title?: string } | null;
  createdAt?: string;
  updatedAt?: string;
};

/** Compact meta: state · author · assignee · checklist · milestone · created · updated */
export function formatIssueMeta(d: IssueMetaSource | null | undefined): string {
  if (!d) return "";
  const assignees =
    (d.assignees || []).map((a) => `@${a.username}`).join(", ") || "—";
  const parts = [d.state || "—"];
  if (d.author?.trim()) parts.push(`author @${d.author.trim()}`);
  parts.push(`assignee ${assignees}`);
  if (d.taskCompletion) {
    parts.push(
      `checklist ${d.taskCompletion.completedCount}/${d.taskCompletion.count}`,
    );
  }
  if (d.milestone?.title) parts.push(`milestone ${d.milestone.title}`);
  const created = formatChatTime(d.createdAt);
  if (created) parts.push(`created ${created}`);
  const updated = formatChatTime(d.updatedAt);
  if (updated) parts.push(`updated ${updated}`);
  return parts.join(" · ");
}
