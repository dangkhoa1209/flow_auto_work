import { getConfig } from "../../config.js";
import { logger } from "../../logger.js";

type TokenCache = { accessToken: string; expiresAt: number };

let tokenCache: TokenCache | null = null;

async function getAccessToken(): Promise<string> {
  const config = getConfig();
  if (!config.TEAMS_TENANT_ID || !config.TEAMS_CLIENT_ID || !config.TEAMS_CLIENT_SECRET) {
    throw new Error("Teams credentials are not configured");
  }

  if (tokenCache && Date.now() < tokenCache.expiresAt - 60_000) {
    return tokenCache.accessToken;
  }

  const url = `https://login.microsoftonline.com/${config.TEAMS_TENANT_ID}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    client_id: config.TEAMS_CLIENT_ID,
    client_secret: config.TEAMS_CLIENT_SECRET,
    scope: "https://graph.microsoft.com/.default",
    grant_type: "client_credentials",
  });

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    throw new Error(`Teams token failed (${res.status}): ${await res.text()}`);
  }
  const data = (await res.json()) as {
    access_token: string;
    expires_in: number;
  };
  tokenCache = {
    accessToken: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
  return tokenCache.accessToken;
}

async function graph(
  method: string,
  apiPath: string,
  body?: unknown,
): Promise<Response> {
  const token = await getAccessToken();
  return fetch(`https://graph.microsoft.com/v1.0${apiPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export async function resolveChatId(): Promise<string> {
  const config = getConfig();
  if (config.TEAMS_CHAT_ID) return config.TEAMS_CHAT_ID;
  if (!config.TEAMS_USER_ID) {
    throw new Error("Set TEAMS_CHAT_ID or TEAMS_USER_ID");
  }

  // Create or get 1:1 chat between the app and the user requires app identity as a user —
  // with pure client credentials, prefer a pre-created TEAMS_CHAT_ID.
  // Best-effort: list chats is not available for app-only without Chat.Read.All on a user.
  throw new Error(
    "TEAMS_USER_ID alone is not enough with client-credentials. Set TEAMS_CHAT_ID of your 1:1 chat.",
  );
}

export async function sendChatMessage(
  chatId: string,
  text: string,
): Promise<{ id: string }> {
  const res = await graph("POST", `/chats/${chatId}/messages`, {
    body: {
      contentType: "text",
      content: text,
    },
  });
  if (!res.ok) {
    throw new Error(`Teams send failed (${res.status}): ${await res.text()}`);
  }
  const data = (await res.json()) as { id: string };
  logger.info("Sent Teams message", { chatId, messageId: data.id });
  return { id: data.id };
}

export type ChatMessage = {
  id: string;
  createdDateTime: string;
  fromUserId?: string;
  body: string;
};

export async function listRecentMessages(
  chatId: string,
  top = 20,
): Promise<ChatMessage[]> {
  const res = await graph(
    "GET",
    `/chats/${chatId}/messages?$top=${top}`,
  );
  if (!res.ok) {
    throw new Error(`Teams list messages failed (${res.status}): ${await res.text()}`);
  }
  const data = (await res.json()) as {
    value: Array<{
      id: string;
      createdDateTime: string;
      from?: { user?: { id?: string } };
      body?: { content?: string };
    }>;
  };

  return (data.value ?? []).map((m) => ({
    id: m.id,
    createdDateTime: m.createdDateTime,
    fromUserId: m.from?.user?.id,
    body: stripHtml(m.body?.content ?? ""),
  }));
}

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

export function findReplyAfter(
  messages: ChatMessage[],
  afterMessageId: string | undefined,
  expectedUserId: string | undefined,
): ChatMessage | null {
  // Graph returns newest first typically
  const ordered = [...messages].sort((a, b) =>
    a.createdDateTime.localeCompare(b.createdDateTime),
  );

  let seenAnchor = !afterMessageId;
  for (const msg of ordered) {
    if (!seenAnchor) {
      if (msg.id === afterMessageId) seenAnchor = true;
      continue;
    }
    if (!msg.body) continue;
    if (expectedUserId && msg.fromUserId && msg.fromUserId !== expectedUserId) {
      continue;
    }
    // Skip our own question echoes if content starts with [aihr #
    if (msg.body.startsWith("[aihr #")) continue;
    return msg;
  }
  return null;
}
