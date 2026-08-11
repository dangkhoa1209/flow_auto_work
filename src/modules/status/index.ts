import { mongoPing } from "../../db/mongo.js";
import { jobQueue } from "../../queue.js";
import { getRuntimeContext } from "../../workspace/runtime.js";

export async function getStatusPayload(opts?: {
  ownerUsername?: string;
  workspaceProjectId?: string;
}) {
  const mongoOk = await mongoPing();
  const rt = getRuntimeContext();
  const ownerUsername = opts?.ownerUsername || rt?.gitlabUsername;
  const workspaceProjectId = opts?.workspaceProjectId || rt?.projectId;
  const queue = jobQueue.snapshotFor({ ownerUsername, workspaceProjectId });
  return {
    ok: true,
    mongo: mongoOk,
    project: rt?.gitlabPath ?? null,
    assignee: rt?.gitlabUsername ?? ownerUsername ?? null,
    multiUser: true,
    secretsEncrypted: true,
    queue,
    currentJobId: queue.currentJobId,
    currentJobIds: queue.currentJobIds,
    queueLength: queue.queued,
  };
}
