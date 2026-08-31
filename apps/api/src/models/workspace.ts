import type { SoftDeleteFields } from "./base.js";
import { createModel } from "./base.js";
import type {
  WorkspaceMembership,
  WorkspaceProject,
  WorkspaceUser,
} from "../workspace/types.js";

export type WorkspaceUserDoc = WorkspaceUser & SoftDeleteFields;
export type WorkspaceProjectDoc = WorkspaceProject & SoftDeleteFields;
export type WorkspaceMembershipDoc = WorkspaceMembership & SoftDeleteFields;

export const WorkspaceUserModel = createModel<WorkspaceUserDoc>({
  collection: "workspace_users",
  softDelete: true,
  defaultSort: { updatedAt: -1 },
  idField: "id",
  parseId: (id) => id,
  indexes: [
    {
      keys: { gitlabUsername: 1 },
      options: { softUnique: true, name: "gitlabUsername_soft_unique" },
    },
  ],
});

export const WorkspaceProjectModel = createModel<WorkspaceProjectDoc>({
  collection: "workspace_projects",
  softDelete: true,
  defaultSort: { updatedAt: -1 },
  idField: "id",
  parseId: (id) => id,
  indexes: [
    {
      keys: { userId: 1, projectName: 1 },
      options: { softUnique: true, name: "userId_projectName_soft_unique" },
    },
    { keys: { userId: 1, isActive: 1 } },
  ],
});

export const WorkspaceMembershipModel = createModel<WorkspaceMembershipDoc>({
  collection: "workspace_memberships",
  softDelete: true,
  defaultSort: { updatedAt: -1 },
  idField: "id",
  parseId: (id) => id,
  indexes: [
    {
      keys: { userId: 1, projectId: 1 },
      options: { softUnique: true, name: "userId_projectId_soft_unique" },
    },
  ],
});
