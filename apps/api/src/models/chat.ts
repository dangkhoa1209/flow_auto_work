import { ObjectId, type WithId } from "mongodb";
import type { SoftDeleteFields } from "./base.js";
import { createModel } from "./base.js";
import { connectMongo } from "./connection.js";
import { publishRealtime } from "../plugins/realtime/hub.js";

export type ChatMessageDoc = {
  _id?: ObjectId | string;
  jobId?: string;
  issueIid: number;
  role: "user" | "agent" | "system";
  kind: "clarify" | "qa" | "note";
  body: string;
  createdAt: string;
} & SoftDeleteFields;

export const ChatModel = createModel<ChatMessageDoc>({
  collection: "chat",
  softDelete: true,
  defaultSort: { createdAt: 1 },
  parseId: (id) => {
    if (!ObjectId.isValid(id)) throw new Error(`Invalid chat id: ${id}`);
    return new ObjectId(id);
  },
  indexes: [
    { keys: { jobId: 1, createdAt: 1 } },
    { keys: { issueIid: 1, createdAt: 1 } },
  ],
});

export function toChatRow(doc: WithId<ChatMessageDoc> | ChatMessageDoc) {
  return {
    ...doc,
    _id: doc._id ? String(doc._id) : undefined,
  };
}

export async function addChatMessage(input: {
  jobId?: string;
  issueIid: number;
  role: "user" | "agent" | "system";
  kind: "clarify" | "qa" | "note";
  body: string;
}): Promise<ChatMessageDoc> {
  await connectMongo();
  const doc: ChatMessageDoc = {
    jobId: input.jobId,
    issueIid: input.issueIid,
    role: input.role,
    kind: input.kind,
    body: input.body.trim(),
    createdAt: new Date().toISOString(),
  };
  const inserted = await ChatModel.insert(doc);
  const saved = { ...inserted, _id: String(inserted._id) };
  // Realtime push — UI appends without polling /chat
  if (saved.jobId) {
    publishRealtime({
      type: "chat",
      jobId: saved.jobId,
      message: {
        id: saved._id,
        jobId: saved.jobId,
        issueIid: saved.issueIid,
        role: saved.role,
        kind: saved.kind,
        body: saved.body,
        createdAt: saved.createdAt,
      },
    });
  }
  return saved;
}

export async function listChatMessages(opts: {
  jobId?: string;
  issueIid?: number;
  limit?: number;
}): Promise<ChatMessageDoc[]> {
  const filter: Record<string, unknown> = {};
  if (opts.jobId) filter.jobId = opts.jobId;
  if (opts.issueIid !== undefined) filter.issueIid = opts.issueIid;
  const rows = await ChatModel.findMany({
    filter,
    sort: { createdAt: 1 },
    limit: opts.limit ?? 200,
  });
  return rows.map((r) => ({
    ...r,
    _id: r._id ? String(r._id) : undefined,
  }));
}
