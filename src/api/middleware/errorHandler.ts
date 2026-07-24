import type { ErrorRequestHandler } from "express";
import { logger } from "../../logger.js";
import { AppError } from "../../utils/AppError.js";

/**
 * Global error handler — must be registered AFTER all routes.
 * Standard JSON: { success: false, message, code?, error? }
 */
export const globalErrorHandler: ErrorRequestHandler = (
  err,
  _req,
  res,
  _next,
) => {
  if (res.headersSent) {
    return;
  }

  if (err instanceof AppError) {
    res.status(err.status).json({
      success: false,
      message: err.message,
      error: err.message,
      code: err.code,
    });
    return;
  }

  const status =
    typeof err === "object" &&
    err &&
    "status" in err &&
    typeof (err as { status: unknown }).status === "number"
      ? (err as { status: number }).status
      : 500;

  const message =
    err instanceof Error ? err.message : typeof err === "string" ? err : "Internal Server Error";

  if (status >= 500) {
    logger.error("Unhandled route error", { err: message });
  }

  res.status(status).json({
    success: false,
    message,
    error: message,
    code: status === 401 ? "unauthorized" : undefined,
  });
};
