import type { NextFunction, Request, Response } from "express";
import { generateFormatters } from "./index.js";

/** Middleware: mount `res.formatter` on every response. */
export function attachResponseFormatter(
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  res.formatter = generateFormatters(res);
  next();
}
