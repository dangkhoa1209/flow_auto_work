import { createModel } from "./base.js";

export type PasswordResetRequestStatus = "pending" | "fulfilled" | "dismissed";

export type PasswordResetRequestDoc = {
  /** Same as normalized username — one open request per user. */
  id: string;
  username: string;
  note: string | null;
  status: PasswordResetRequestStatus;
  requestedAt: string;
  updatedAt: string;
};

export const PasswordResetRequestModel = createModel<PasswordResetRequestDoc>({
  collection: "password_reset_requests",
  softDelete: false,
  defaultSort: { requestedAt: -1 },
  idField: "id",
  parseId: (id) => id,
  indexes: [
    { keys: { status: 1, requestedAt: -1 }, options: { name: "status_requestedAt" } },
    { keys: { username: 1 }, options: { name: "username_1" } },
  ],
});
