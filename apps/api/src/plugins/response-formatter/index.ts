import type { Response } from "express";
import {
  FORMATTER_METHODS,
  type FormatterMethod,
  type FormatterMethodName,
} from "./methods.js";

export type SuccessEnvelope = {
  success: true;
  data: unknown;
  meta?: unknown;
  message: string;
  code: number;
  status: number;
  name: FormatterMethodName;
};

export type ErrorEnvelope = {
  success: false;
  /** Alias for FE that still reads `error` */
  error: string;
  errors?: unknown;
  meta?: unknown;
  message: string;
  code?: string | number;
  status: number;
  name: FormatterMethodName;
};

export type ResponseFormatter = {
  [K in FormatterMethodName]: (
    dataOrErrors?: unknown,
    meta?: unknown,
    statusOverride?: number,
  ) => void;
};

function successBody(
  method: FormatterMethod,
  data: unknown,
  meta: unknown,
  status: number,
): SuccessEnvelope {
  return {
    success: true,
    data,
    meta,
    message: method.message,
    code: method.code,
    status,
    name: method.name,
  };
}

function errorBody(
  method: FormatterMethod,
  errors: unknown,
  meta: unknown,
  status: number,
): ErrorEnvelope {
  let message = method.message;
  let normalized: unknown = errors;
  if (typeof errors === "string") {
    message = errors;
    normalized = [errors];
  } else if (errors instanceof Error) {
    message = errors.message;
    normalized = [errors.message];
  } else if (
    errors &&
    typeof errors === "object" &&
    "message" in errors &&
    typeof (errors as { message: unknown }).message === "string"
  ) {
    message = (errors as { message: string }).message;
    normalized = [message];
  } else if (errors == null) {
    normalized = [method.message];
  }

  return {
    success: false,
    error: message,
    errors: normalized,
    meta,
    message,
    code: method.code,
    status,
    name: method.name,
  };
}

/** Attach HTS-style `res.formatter` helpers (ok / created / notFound / …). */
export function generateFormatters(res: Response): ResponseFormatter {
  const formatter = {} as ResponseFormatter;

  for (const method of FORMATTER_METHODS) {
    if (method.isSuccess) {
      formatter[method.name] = (data, meta, statusOverride) => {
        if (method.name === "noContent") {
          res.status(statusOverride ?? method.code).end();
          return;
        }
        const status = statusOverride ?? method.code;
        res.status(status).json(successBody(method, data, meta, status));
      };
    } else {
      formatter[method.name] = (errors, meta, statusOverride) => {
        const status = statusOverride ?? method.code;
        res.status(status).json(errorBody(method, errors, meta, status));
      };
    }
  }

  return formatter;
}

/** Map HTTP status → formatter method name. */
export function formatterMethodForStatus(
  status: number,
): FormatterMethodName {
  switch (status) {
    case 400:
      return "badRequest";
    case 401:
      return "unauthorized";
    case 403:
      return "forbidden";
    case 404:
      return "notFound";
    case 405:
      return "methodNotAllowed";
    case 408:
      return "timeout";
    case 409:
      return "conflict";
    case 422:
      return "unprocess";
    case 429:
      return "tooManyRequests";
    case 502:
      return "badGateway";
    case 503:
      return "serviceUnavailable";
    case 504:
      return "gatewayTimeout";
    default:
      return status >= 500 ? "serverError" : "badRequest";
  }
}
