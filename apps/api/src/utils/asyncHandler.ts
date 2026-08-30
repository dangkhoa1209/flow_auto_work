import type { NextFunction, Request, RequestHandler, Response } from "express";

/**
 * Express 4 does not catch rejected promises from async route handlers.
 * Wrap every async controller so errors flow to the global error middleware.
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
