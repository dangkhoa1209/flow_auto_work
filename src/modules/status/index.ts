import { listPendingClarifications } from "../../plugins/clarify/ui-wait.js";
import { mongoPing } from "../../db/mongo.js";
import { jobQueue } from "../../queue.js";
import { getRuntimeContext } from "../../workspace/runtime.js";

export async function getStatusPayload() {
  const mongoOk = await mongoPing();
  const queue = jobQueue.snapshot();
  const rt = getRuntimeContext();
  return {
    ok: true,
    mongo: mongoOk,
    project: rt?.gitlabPath ?? null,
    assignee: rt?.gitlabUsername ?? null,
    multiUser: true,
    secretsEncrypted: true,
    queue,
    currentJobId: queue.currentJobId,
    queueLength: queue.queued,
    pendingClarifications: listPendingClarifications(),
  };
}
