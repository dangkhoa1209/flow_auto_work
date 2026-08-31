import { getConfig } from "../../config.js";
import {
  listProjectLabels,
  listProjectMembers,
  listProjectMilestones,
} from "../../plugins/scm/index.js";

export async function getCompletionDefaults() {
  const config = getConfig();
  return {
    assignees: config.onCompleteAssignUsernames,
    labels: config.onCompleteLabels,
    comment: config.ON_COMPLETE_COMMENT ?? "",
  };
}

export async function listMembers() {
  const members = await listProjectMembers();
  return { members };
}

export async function listLabels() {
  const labels = (await listProjectLabels())
    .map((l) => {
      const name = (typeof l === "string" ? l : l?.name)?.trim();
      if (!name) return null;
      if (typeof l === "string") return { name };
      return {
        name,
        color: l.color,
        textColor: l.textColor,
      };
    })
    .filter((row): row is NonNullable<typeof row> => Boolean(row));
  return { labels };
}

export async function listMilestones() {
  const milestones = await listProjectMilestones();
  const titles = [
    ...new Set(
      milestones
        .map((m) => m.title?.trim())
        .filter((t): t is string => Boolean(t)),
    ),
  ].sort((a, b) => a.localeCompare(b));
  return { milestones: titles };
}
