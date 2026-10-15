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
 * Postgres SQLSTATE codes this system can produce from a caller's own input.
 *
 * These are not server faults. Each one means the database refused something
 * the caller sent, which is a 4xx with an explanation — reporting them as a 500
 * tells an operator their server is down when it is running fine and their
 * request is wrong.
 *
 *   23502 not_null_violation   — a required value was absent
 *   23503 foreign_key_violation — a referenced row does not exist
 *   23505 unique_violation      — a uniqueness rule refused the row
 *
 * The constraint NAME is what makes the message specific. Postgres puts it in
 * `err.constraint`, which is why these are keyed on that rather than on the
 * message text: the name is stable across driver versions, the prose is not.
 */
const CONSTRAINT_STATUS: Record<string, { status: number; code: string }> = {
  // The one that mattered. A card without a destination is legitimate ONLY
  // after 00015 has been applied; before it, every card-stock create lands here
  // and was being reported as "internal_error", which reads as a dead server
  // rather than as an unapplied migration.
  links_original_url_not_null: {
    status: 409,
    code: "schema_not_migrated",
  },
  idx_locations_tenant_slug: { status: 409, code: "slug_taken" },
};

/**
 * Recognises a database constraint failure, if this throw is one.
 *
 * Duck-typed on `code` because `pg` errors are not an importable class the
 * middleware should depend on, and on `constraint` because that is the only
 * stable identifier. Returns null for anything else, so the caller falls through
 * to the 500 it would have returned anyway.
 */
function asConstraintViolation(
  err: unknown,
): { status: number; code: string; constraint: string } | null {
  if (err === null || typeof err !== "object") return null;
  const e = err as { code?: unknown; constraint?: unknown; message?: unknown };

  // 23xxx is the integrity-constraint class in SQLSTATE. Checking the prefix
  // rather than the exact code means an unlisted constraint is still reported
  // as a caller error rather than as a server fault.
  if (typeof e.code !== "string" || !e.code.startsWith("23")) return null;

  const constraint = typeof e.constraint === "string" ? e.constraint : "";
  const known = CONSTRAINT_STATUS[constraint];
  if (known) return { ...known, constraint };

  // A recognised integrity violation with no specific mapping still describes a
  // bad request, not a broken server.
  return {
    status: 409,
    code: "constraint_violation",
    constraint,
  };
}

/**
 * Maps a thrown value to its HTTP status and response body.
 *
 * Known `AppError` subclasses map to their declared status; database integrity
 * violations map to a 4xx that names the constraint; anything else is an opaque
 * 500. Pure — no logging, no context, no I/O — so the mapping is directly
 * unit-testable and cannot accidentally leak a stack trace.
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

  const violation = asConstraintViolation(err);
  if (violation) {
    // The constraint name is safe to surface: it is part of this system's own
    // schema, not user data, and it is the difference between "something is
    // wrong" and "this specific migration has not been applied".
    return {
      status: violation.status,
      body: {
        error:
          violation.code === "schema_not_migrated"
            ? "this tenant's schema does not yet allow a link with no destination; apply migration 00015"
            : `constraint ${violation.constraint} rejected the request`,
        code: violation.code,
      },
      type: "ConstraintViolation",
      message:
        err instanceof Error ? err.message : `constraint ${violation.constraint}`,
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
