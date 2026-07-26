import { getConfig } from "../../config.js";
import {
  listProjectLabels,
  listProjectMembers,
} from "../../plugins/gitlab/client.js";

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
    .map((l) => (typeof l === "string" ? l : l?.name)?.trim())
    .filter((n): n is string => Boolean(n));
  return { labels };
}
