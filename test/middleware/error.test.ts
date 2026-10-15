import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  errorHandler,
  mapError,
  buildErrorLog,
  AppError,
  ValidationError,
  AuthError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  GoneError,
  LimitError,
  DatabaseError,
} from "../../src/middleware/error";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Minimal stand-in for a Hono context exposing only what `errorHandler` uses:
 * `json()` and `get()`.
 */
function mockContext(overrides: { tenantSlug?: string; getThrows?: boolean } = {}) {
  const jsonFn = vi.fn().mockImplementation(
    (body: unknown, status: number) =>
      new Response(JSON.stringify(body), { status }),
  );

  const getFn = vi.fn(() => {
    if (overrides.getThrows) throw new Error("context unavailable");
    return overrides.tenantSlug ? { tenantSlug: overrides.tenantSlug } : undefined;
  });

  const c = { json: jsonFn, get: getFn, env: {} };
  return { c, jsonFn };
}

let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Returns the JSON payload of the first `c.json()` call. */
function loggedEntry(jsonFn: ReturnType<typeof vi.fn>, call = 0) {
  return JSON.parse(consoleErrorSpy.mock.calls[call]![0] as string);
}

// ---------------------------------------------------------------------------
// mapError — pure status/body mapping (REQ-O001 no PII in errors)
// ---------------------------------------------------------------------------

describe("mapError", () => {
  it("maps ValidationError to 400", () => {
    expect(
      mapError(new ValidationError("Invalid input", "invalid_url")),
    ).toMatchObject({
      status: 400,
      body: { error: "Invalid input", code: "invalid_url" },
    });
  });

  it("maps AuthError to 401", () => {
    expect(mapError(new AuthError())).toMatchObject({
      status: 401,
      body: { error: "unauthenticated", code: "unauthenticated" },
    });
  });

  it("maps ForbiddenError to 403", () => {
    expect(mapError(new ForbiddenError("Not allowed"))).toMatchObject({
      status: 403,
      body: { error: "Not allowed", code: "forbidden" },
    });
  });

  it("maps NotFoundError to 404", () => {
    expect(
      mapError(new NotFoundError("Tenant not found", "tenant_not_found")),
    ).toMatchObject({
      status: 404,
      body: { error: "Tenant not found", code: "tenant_not_found" },
    });
  });

  // -------------------------------------------------------------------------
  // Database integrity violations
  //
  // These arrived in production as `500 internal_error` with the log line
  // "null value in column original_url ... violates not-null constraint" — a
  // server that was running perfectly, refusing a card because migration 00015
  // had not been applied. An operator reading "internal_error" checks their
  // infrastructure. An operator reading "apply migration 00015" fixes it in one
  // step.
  //
  // The distinction is not cosmetic: it is the difference between a five-minute
  // fix and a false alarm during business hours.
  // -------------------------------------------------------------------------

  it("maps an unapplied 00015 to a 409 that names the migration", () => {
    // The exact shape observed in production.
    const pgError = Object.assign(
      new Error('null value in column "original_url" of relation "links" violates not-null constraint'),
      { code: "23502", constraint: "links_original_url_not_null" },
    );

    expect(mapError(pgError)).toMatchObject({
      status: 409,
      body: { code: "schema_not_migrated" },
      type: "ConstraintViolation",
    });
  });

  it("tells the caller which migration to apply", () => {
    const pgError = Object.assign(new Error("..."), {
      code: "23502",
      constraint: "links_original_url_not_null",
    });

    // The whole point: a response that says what to do, not just what failed.
    expect(mapError(pgError).body.error).toMatch(/00015/);
  });

  it("keeps the underlying message in the log only, never in the body", () => {
    const pgError = Object.assign(
      new Error('null value in column "original_url" ...'),
      { code: "23502", constraint: "links_original_url_not_null" },
    );

    // REQ-O001: no internals in a response body.
    const mapped = mapError(pgError);
    expect(mapped.body.error).not.toMatch(/null value in column/);
    expect(mapped.message).toMatch(/null value in column/);
  });

  it("maps an unlisted integrity violation to a 4xx, not a 500", () => {
    // "A valid uuid is not enough" — the server is fine, the request is not.
    const pgError = Object.assign(new Error("..."), {
      code: "23503",
      constraint: "some_fk",
    });

    expect(mapError(pgError).status).toBe(409);
  });

  it("maps a unique violation on a location slug to slug_taken", () => {
    const pgError = Object.assign(new Error("..."), {
      code: "23505",
      constraint: "idx_locations_tenant_slug",
    });

    expect(mapError(pgError)).toMatchObject({
      status: 409,
      body: { code: "slug_taken" },
    });
  });

  it("still returns an opaque 500 for a genuine server fault", () => {
    // A connection failure or a bug is NOT a caller error. This mapping must not
    // become a blanket 409 that hides real outages.
    expect(mapError(new Error("ECONNREFUSED"))).toMatchObject({
      status: 500,
      body: { error: "internal_error", code: "internal_error" },
    });
  });

  it("does not mistake a string that looks like a code for a violation", () => {
    expect(mapError({ code: "23502" })).toMatchObject({ status: 409 });
    expect(mapError({ message: "23502" })).toMatchObject({ status: 500 });
  });

  it("maps ConflictError to 409", () => {
    expect(
      mapError(new ConflictError("Already taken", "subdomain_taken")),
    ).toMatchObject({
      status: 409,
      body: { error: "Already taken", code: "subdomain_taken" },
    });
  });

  it("maps GoneError to 410", () => {
    expect(mapError(new GoneError("Link expired", "link_expired"))).toMatchObject({
      status: 410,
      body: { error: "Link expired", code: "link_expired" },
    });
  });

  it("maps LimitError to 429", () => {
    expect(
      mapError(new LimitError("Too many links", "link_limit_reached")),
    ).toMatchObject({
      status: 429,
      body: { error: "Too many links", code: "link_limit_reached" },
    });
  });

  it("maps DatabaseError to 503", () => {
    expect(
      mapError(new DatabaseError("DB down", "service_unavailable")),
    ).toMatchObject({
      status: 503,
      body: { error: "DB down", code: "service_unavailable" },
    });
  });

  it("maps unknown errors to 500 with a generic body", () => {
    const mapped = mapError(new Error("Unexpected crash"));

    expect(mapped.status).toBe(500);
    expect(mapped.body).toEqual({
      error: "internal_error",
      code: "internal_error",
    });
  });

  it("maps non-Error thrown values to 500", () => {
    expect(mapError("string error").status).toBe(500);
    expect(mapError(undefined).status).toBe(500);
  });

  it("does not expose the internal message in the 500 body", () => {
    const error = new Error("boom");
    error.stack = "Error: boom\n    at test.ts:1:2";

    const body = mapError(error).body;

    expect(body).toEqual({ error: "internal_error", code: "internal_error" });
    expect(JSON.stringify(body)).not.toContain("at test.ts");
    expect(JSON.stringify(body)).not.toContain("boom");
  });

  it("keeps the internal message available for the log only", () => {
    expect(mapError(new Error("boom")).message).toBe("boom");
  });

  it("maps a custom AppError to its declared status", () => {
    expect(mapError(new AppError("Custom error", "custom_code", 418))).toMatchObject(
      { status: 418, body: { error: "Custom error", code: "custom_code" } },
    );
  });
});

// ---------------------------------------------------------------------------
// buildErrorLog — structured log shape
// ---------------------------------------------------------------------------

describe("buildErrorLog", () => {
  it("emits the required structured fields", () => {
    const log = buildErrorLog(mapError(new ValidationError("bad", "invalid_url")));

    expect(log).toEqual({
      event: "error",
      status: 400,
      type: "ValidationError",
      message: "bad",
      code: "invalid_url",
    });
  });

  it("labels unknown errors as unknown_error", () => {
    const log = buildErrorLog(mapError(new Error("boom")));

    expect(log.type).toBe("unknown_error");
    expect(log.status).toBe(500);
  });

  it("stringifies non-Error thrown values into the log message", () => {
    expect(buildErrorLog(mapError("boom")).message).toBe("boom");
  });

  it("omits tenant when no slug is supplied", () => {
    expect(buildErrorLog(mapError(new Error("boom")))).not.toHaveProperty("tenant");
  });

  it("includes tenant when a slug is supplied", () => {
    expect(
      buildErrorLog(mapError(new Error("boom")), "acme"),
    ).toHaveProperty("tenant", "acme");
  });

  it("never carries a stack trace", () => {
    const error = new Error("boom");
    error.stack = "Error: boom\n    at test.ts:1:2";

    expect(JSON.stringify(buildErrorLog(mapError(error)))).not.toContain("at test.ts");
  });
});

// ---------------------------------------------------------------------------
// errorHandler — thin Hono wrapper around the two pure functions
// ---------------------------------------------------------------------------

describe("errorHandler", () => {
  it("returns the mapped status and JSON body", async () => {
    const { c, jsonFn } = mockContext();

    const res = await errorHandler(
      new NotFoundError("Link not found", "not_found"),
      c as any,
    );

    expect(jsonFn).toHaveBeenCalledWith(
      { error: "Link not found", code: "not_found" },
      404,
    );
    expect(res.status).toBe(404);
  });

  it("returns 500 with a generic body for unknown errors", async () => {
    const { c, jsonFn } = mockContext();

    const res = await errorHandler(new Error("boom"), c as any);

    expect(jsonFn).toHaveBeenCalledWith(
      { error: "internal_error", code: "internal_error" },
      500,
    );
    expect(res.status).toBe(500);
  });

  it("logs the structured entry as JSON", async () => {
    const { c } = mockContext();

    await errorHandler(new ValidationError("bad", "invalid_url"), c as any);

    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    expect(loggedEntry(vi.fn())).toEqual({
      event: "error",
      status: 400,
      type: "ValidationError",
      message: "bad",
      code: "invalid_url",
    });
  });

  it("attaches tenant context to the log when available", async () => {
    const { c } = mockContext({ tenantSlug: "acme" });

    await errorHandler(new NotFoundError(), c as any);

    expect(loggedEntry(vi.fn())).toHaveProperty("tenant", "acme");
  });

  it("still responds when reading the tenant context throws", async () => {
    const { c, jsonFn } = mockContext({ getThrows: true });

    const res = await errorHandler(new NotFoundError(), c as any);

    expect(jsonFn).toHaveBeenCalledWith(
      { error: "not_found", code: "not_found" },
      404,
    );
    expect(res.status).toBe(404);
    expect(loggedEntry(vi.fn())).not.toHaveProperty("tenant");
  });

  it("never lets a stack trace reach the response body", async () => {
    const { c } = mockContext();
    const error = new Error("boom");
    error.stack = "Error: boom\n    at test.ts:1:2";

    const res = await errorHandler(error, c as any);

    await expect(res.text()).resolves.toBe(
      JSON.stringify({ error: "internal_error", code: "internal_error" }),
    );
  });
});