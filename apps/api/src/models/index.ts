/**
 * Domain models registry — call `ensureAllModelIndexes()` once after Mongo connects.
 * Soft-delete collections use partial unique indexes so deleted rows do not block re-create.
 */
import { BaMessageModel, BaProjectModel, BaRequirementModel, BaTaskDraftModel, BaThreadModel, SystemSettingsModel } from "./ba.js";
import { ChatModel } from "./chat.js";
import { BuildJobModel, BuildScriptModel } from "./devops.js";
import { JobModel } from "./job.js";
import { NoteModel } from "./note.js";
import {
  QcFlowModel,
  QcProjectModel,
  QcSampleFileModel,
  QcTestCaseModel,
} from "./qc.js";
import { CursorUsageModel } from "./cursorUsage.js";
import { StatsAnalysisCacheModel } from "./stats.js";
import {
  WorkspaceMembershipModel,
  WorkspaceProjectModel,
  WorkspaceUserModel,
} from "./workspace.js";
import { connectMongo } from "./connection.js";
import { logger } from "../logger.js";

const ALL_MODELS = [
  JobModel,
  ChatModel,
  NoteModel,
  QcProjectModel,
  QcFlowModel,
  QcTestCaseModel,
  QcSampleFileModel,
  WorkspaceUserModel,
  WorkspaceProjectModel,
  WorkspaceMembershipModel,
  BaProjectModel,
  BaThreadModel,
  BaMessageModel,
  BaRequirementModel,
  BaTaskDraftModel,
  SystemSettingsModel,
  BuildJobModel,
  BuildScriptModel,
  StatsAnalysisCacheModel,
  CursorUsageModel,
] as const;

/** Drop legacy unique indexes that conflict with soft-delete partial uniques. */
async function dropLegacyUniqueIndexes(): Promise<void> {
  const db = await connectMongo();
  const drops: Array<[string, string]> = [
    ["jobs", "ws_project_issue_unique"],
    ["workspace_users", "gitlabUsername_1"],
    ["workspace_projects", "userId_1_projectName_1"],
    ["workspace_memberships", "userId_1_projectId_1"],
    ["ba_projects", "slug_1"],
    ["build_scripts", "id_1"],
  ];
  for (const [coll, indexName] of drops) {
    try {
      await db.collection(coll).dropIndex(indexName);
      logger.info("Dropped legacy unique index for soft-delete", {
        collection: coll,
        index: indexName,
      });
    } catch {
      /* missing — ok */
    }
  }
}

let ready = false;

export async function ensureAllModelIndexes(): Promise<void> {
  if (ready) return;
  await dropLegacyUniqueIndexes();
  for (const model of ALL_MODELS) {
    await model.ensureIndexes();
  }
  ready = true;
  logger.info("Model indexes ready", {
    models: ALL_MODELS.map((m) => m.collectionName),
  });
}

export {
  JobModel,
  ChatModel,
  NoteModel,
  QcProjectModel,
  QcFlowModel,
  QcTestCaseModel,
  QcSampleFileModel,
  WorkspaceUserModel,
  WorkspaceProjectModel,
  WorkspaceMembershipModel,
  BaProjectModel,
  BaThreadModel,
  BaMessageModel,
  BaRequirementModel,
  BaTaskDraftModel,
  SystemSettingsModel,
  BuildJobModel,
  BuildScriptModel,
  StatsAnalysisCacheModel,
  CursorUsageModel,
};
