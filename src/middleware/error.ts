import type { ErrorHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AppEnv, HonoVars } from "../types/env";

// ---------------------------------------------------------------------------
// Custom error classes with HTTP status codes
// ---------------------------------------------------------------------------

/**
 * Base class for application errors that map to specific HTTP status codes.
 * Handlers and middleware throw these; the error middleware catches them
 * and returns the correct status + structured JSON body.
 */
export class AppError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "AppError";
  }
}

/** Client input validation failure — HTTP 400. */
export class ValidationError extends AppError {
  constructor(message: string, code = "invalid_request") {
    super(message, code, 400);
    this.name = "ValidationError";
  }
}

/** Missing or invalid authentication — HTTP 401. */
export class AuthError extends AppError {
  constructor(message = "unauthenticated") {
    super(message, "unauthenticated", 401);
    this.name = "AuthError";
  }
}

/** Valid auth but insufficient permissions — HTTP 403. */
export class ForbiddenError extends AppError {
  constructor(message = "forbidden") {
    super(message, "forbidden", 403);
    this.name = "ForbiddenError";
  }
}

/** Resource not found — HTTP 404. */
export class NotFoundError extends AppError {
  constructor(message = "not_found", code = "not_found") {
    super(message, code, 404);
    this.name = "NotFoundError";
  }
}

/** Resource conflict (e.g., duplicate slug) — HTTP 409. */
export class ConflictError extends AppError {
  constructor(message: string, code = "conflict") {
    super(message, code, 409);
    this.name = "ConflictError";
  }
}

/** Resource exists but is no longer available — HTTP 410. */
export class GoneError extends AppError {
  constructor(message: string, code = "gone") {
    super(message, code, 410);
    this.name = "GoneError";
  }
}

/** Rate limit or quota exceeded — HTTP 429. */
export class LimitError extends AppError {
  constructor(message: string, code = "limit_exceeded") {
    super(message, code, 429);
    this.name = "LimitError";
  }
}

/** Database or downstream service unavailable — HTTP 503. */
export class DatabaseError extends AppError {
  constructor(message: string, code = "service_unavailable") {
    super(message, code, 503);
    this.name = "DatabaseError";
  }
}

// ---------------------------------------------------------------------------
// Error mapping (pure)
// ---------------------------------------------------------------------------

/** The `{ error, code }` payload returned to the client. */
export interface ErrorBody {
  error: string;
  code: string;
}

/** Fully resolved outcome for a thrown value. */
export interface MappedError {
  status: number;
  body: ErrorBody;
  /** Error class name, or `"unknown_error"` for non-`Error` throws. */
  type: string;
  /** Message for the log only — never for the response body of a 500. */
  message: string;
}

/**
 * Maps a thrown value to its HTTP status and response body.
 *
 * Known `AppError` subclasses map to their declared status; anything else is
 * an opaque 500. Pure — no logging, no context, no I/O — so the mapping is
 * directly unit-testable and cannot accidentally leak a stack trace.
 */
export function mapError(err: unknown): MappedError {
  if (err instanceof AppError) {
    return {
      status: err.status,
      body: { error: err.message, code: err.code },
      type: err.name,
      message: err.message,
    };
  }

  return {
    status: 500,
    body: { error: "internal_error", code: "internal_error" },
    type: "unknown_error",
    message: err instanceof Error ? err.message : String(err),
  };
}

/**
 * Builds the structured log entry for a mapped error.
 *
 * No stack traces and no PII, per REQ-O001. `tenantSlug` is included only when
 * the caller managed to read it off the context.
 */
export function buildErrorLog(
  mapped: MappedError,
  tenantSlug?: string,
): Record<string, unknown> {
  const logEntry: Record<string, unknown> = {
    event: "error",
    status: mapped.status,
    type: mapped.type,
    message: mapped.message,
    code: mapped.body.code,
  };

  if (tenantSlug) {
    logEntry.tenant = tenantSlug;
  }

  return logEntry;
}

// ---------------------------------------------------------------------------
// Hono error handler
// ---------------------------------------------------------------------------

/**
 * Application-wide error handler, installed via `app.onError`.
 *
 * This MUST be an `onError` handler rather than `app.use("*", ...)`: Hono's
 * `compose` installs its own `catch` on the frame that invokes the throwing
 * handler, so an `await next()` middleware never observes a downstream throw —
 * Hono's built-in handler converts it to a 500 `text/plain` response one frame
 * below the middleware.
 *
 * On every throw this:
 * - Maps known `AppError` subclasses to their HTTP status codes
 * - Logs the error as structured JSON (no stack traces, no PII)
 * - Returns a consistent `{ error, code }` JSON body
 *
 * It never returns the bare `Error`; Hono would then print the raw stack.
 */
export const errorHandler: ErrorHandler<{
  Bindings: AppEnv;
  Variables: HonoVars;
}> = (err, c) => {
  const mapped = mapError(err as unknown);

  // Tenant context may be absent (e.g. the throw happened before the tenant
  // middleware ran). Reading it must never make error reporting throw.
  let tenantSlug: string | undefined;
  try {
    tenantSlug = c.get("tenant")?.tenantSlug;
  } catch {
    // Ignore — the log just goes out without tenant context.
  }

  console.error(JSON.stringify(buildErrorLog(mapped, tenantSlug)));

  return c.json(mapped.body, mapped.status as ContentfulStatusCode);
};
