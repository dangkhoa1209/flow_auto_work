import { getConfig } from "../config.js";
import { logger } from "../logger.js";
import type { IssueJob } from "../types.js";
import {
  findReplyAfter,
  listRecentMessages,
  resolveChatId,
  sendChatMessage,
} from "./client.js";

export async function askAndWaitForReply(opts: {
  issue: IssueJob;
  question: string;
}): Promise<string> {
  const config = getConfig();
  if (!config.teamsEnabled) {
    throw new Error(
      "Clarification needed but Teams is not configured. Set TEAMS_* env vars.",
    );
  }

  const chatId = await resolveChatId();
  const content = [
    `[aihr #${opts.issue.issueIid}] Need clarification`,
    opts.issue.url ? `Issue: ${opts.issue.url}` : "",
    "",
    opts.question,
    "",
    "Reply in this chat with your answer.",
  ]
    .filter(Boolean)
    .join("\n");

  const sent = await sendChatMessage(chatId, content);
  logger.info("Waiting for Teams reply", {
    issueIid: opts.issue.issueIid,
    timeoutMin: config.TEAMS_CLARIFY_TIMEOUT_MIN,
  });

  const deadline =
    Date.now() + config.TEAMS_CLARIFY_TIMEOUT_MIN * 60 * 1000;

  while (Date.now() < deadline) {
    await sleep(config.TEAMS_POLL_INTERVAL_SEC * 1000);
    try {
      const messages = await listRecentMessages(chatId, 30);
      const reply = findReplyAfter(
        messages,
        sent.id,
        config.TEAMS_USER_ID,
      );
      if (reply?.body) {
        logger.info("Received Teams reply", {
          messageId: reply.id,
          preview: reply.body.slice(0, 120),
        });
        return reply.body;
      }
    } catch (err) {
      logger.warn("Teams poll error", { err: String(err) });
    }
  }

  throw new Error(
    `Timed out waiting for Teams reply after ${config.TEAMS_CLARIFY_TIMEOUT_MIN} minutes`,
  );
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
