import type { Request, Response } from "express";
import { asyncHandler } from "../../utils/asyncHandler.js";
import {
  getAuthBootstrap,
  loginUser,
  logoutUser,
  refreshAuthTokens,
  registerUser,
  resolveTokenUser,
  type LoginBody,
  type RegisterBody,
} from "../../modules/auth/index.js";
import { headerUserFromExpress } from "../middleware/workspaceAuth.js";

export const authController = {
  bootstrap: asyncHandler(async (_req: Request, res: Response) => {
    res.formatter.ok(getAuthBootstrap());
  }),

  resolveToken: asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { gitlabToken?: string };
    res.formatter.ok(await resolveTokenUser(body));
  }),

  register: asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as RegisterBody;
    res.formatter.ok(await registerUser(body));
  }),

  login: asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as LoginBody;
    res.formatter.ok(await loginUser(body));
  }),

  refresh: asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { refreshToken?: string };
    res.formatter.ok(await refreshAuthTokens(body));
  }),

  logout: asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { refreshToken?: string; all?: boolean };
    res.formatter.ok(await logoutUser(headerUserFromExpress(req), body));
  }),
};
