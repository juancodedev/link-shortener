import type { MiddlewareHandler } from "hono";
import type { HonoVars } from "../types/env";

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
// Error-handling middleware
// ---------------------------------------------------------------------------

/**
 * Outermost error-handling middleware.
 *
 * Wraps all route handlers. Catches any thrown error and:
 * - Maps known `AppError` subclasses to their HTTP status codes
 * - Logs the error as structured JSON (no stack traces, no PII)
 * - Returns a consistent `{ error, code }` JSON body
 *
 * Unknown errors → 500 with generic message (no stack traces leaked).
 */
export const errorHandler: MiddlewareHandler<{
  Variables: HonoVars;
}> = async (c, next) => {
  try {
    await next();
    return;
  } catch (err) {
    // Determine status and code
    let status: number;
    let errorMessage: string;
    let errorCode: string;

    if (err instanceof AppError) {
      status = err.status;
      errorMessage = err.message;
      errorCode = err.code;
    } else {
      status = 500;
      errorMessage = "internal_error";
      errorCode = "internal_error";
    }

    // Structured JSON log — never include stack traces or PII
    const logEntry: Record<string, unknown> = {
      event: "error",
      status,
      type: err instanceof AppError ? err.name : "unknown_error",
      message: err instanceof Error ? err.message : String(err),
      code: errorCode,
    };

    // Add tenant context if available (from previously set middleware)
    try {
      const tenant = c.get("tenant");
      if (tenant) {
        logEntry.tenant = tenant.tenantSlug;
      }
    } catch {
      // Context lookup might fail if tenant middleware hasn't run
    }

    console.error(JSON.stringify(logEntry));

    return c.json({ error: errorMessage, code: errorCode }, status as 200);
  }
};
