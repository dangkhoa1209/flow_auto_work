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
    res.json(getAuthBootstrap());
  }),

  resolveToken: asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { gitlabToken?: string };
    res.json(await resolveTokenUser(body));
  }),

  register: asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as RegisterBody;
    res.json(await registerUser(body));
  }),

  login: asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as LoginBody;
    res.json(await loginUser(body));
  }),

  refresh: asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { refreshToken?: string };
    res.json(await refreshAuthTokens(body));
  }),

  logout: asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { refreshToken?: string; all?: boolean };
    res.json(await logoutUser(headerUserFromExpress(req), body));
  }),
};
