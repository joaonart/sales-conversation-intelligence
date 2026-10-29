/** Errors the client may see. Anything else is reported as INTERNAL with a request id and no detail. */
export type ErrorCode =
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "INVALID_INPUT"
  | "NOT_FOUND"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "UNAVAILABLE"
  | "INTERNAL";

export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: readonly string[],
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const invalid = (message: string, details?: readonly string[]): AppError => new AppError("INVALID_INPUT", message, details);
export const forbidden = (message = "Acesso negado."): AppError => new AppError("FORBIDDEN", message);
export const notFound = (message: string): AppError => new AppError("NOT_FOUND", message);
export const conflict = (message: string): AppError => new AppError("CONFLICT", message);
