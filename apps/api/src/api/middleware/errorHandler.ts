import type { ErrorRequestHandler } from "express";
import { logger } from "../../logger.js";
import {
  formatterMethodForStatus,
  generateFormatters,
} from "../../plugins/response-formatter/index.js";
import { AppError } from "../../utils/AppError.js";

/**
 * Global error handler — must be registered AFTER all routes.
 * Uses `res.formatter` when available; keeps `{ success: false, message, error }`.
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

  if (!res.formatter) {
    res.formatter = generateFormatters(res);
  }

  if (err instanceof AppError) {
    const method = formatterMethodForStatus(err.status);
    res.formatter[method](err.message, undefined, err.status);
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
    err instanceof Error
      ? err.message
      : typeof err === "string"
        ? err
        : "Internal Server Error";

  if (status >= 500) {
    logger.error("Unhandled route error", { err: message });
  }

  const method = formatterMethodForStatus(status);
  res.formatter[method](message, undefined, status);
};
