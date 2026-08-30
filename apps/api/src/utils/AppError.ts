/**
 * Application error with HTTP status — thrown from services/controllers,
 * caught by global Express error middleware.
 */
export class AppError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly success = false as const;

  constructor(message: string, status = 400, code?: string) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
  }
}
