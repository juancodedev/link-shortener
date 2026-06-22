import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  errorHandler,
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
// Helper: mock Hono context
// ---------------------------------------------------------------------------

function mockContext(overrides: { tenantSlug?: string } = {}) {
  const jsonFn = vi.fn().mockImplementation(
    (body: unknown, status: number) =>
      new Response(JSON.stringify(body), { status }),
  );
  const getFn = vi.fn();

  if (overrides.tenantSlug) {
    getFn.mockReturnValue({ tenantSlug: overrides.tenantSlug });
  }

  const c = {
    json: jsonFn,
    get: getFn,
    env: {},
  };

  return { c, jsonFn };
}

// ---------------------------------------------------------------------------
// Error middleware tests (REQ-O001 no PII in errors)
// ---------------------------------------------------------------------------

describe("errorHandler middleware", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes through when no error is thrown", async () => {
    const { c } = mockContext();
    const nextFn = vi.fn().mockResolvedValue(undefined);

    // Should not throw
    await expect(
      errorHandler(c as any, nextFn as any),
    ).resolves.toBeUndefined();
  });

  // --- Known error status mapping ---

  it("maps ValidationError to 400", async () => {
    const { c, jsonFn } = mockContext();
    const nextFn = vi.fn().mockRejectedValue(
      new ValidationError("Invalid input", "invalid_url"),
    );

    await errorHandler(c as any, nextFn as any);

    expect(jsonFn).toHaveBeenCalledWith(
      { error: "Invalid input", code: "invalid_url" },
      400,
    );
  });

  it("maps AuthError to 401", async () => {
    const { c, jsonFn } = mockContext();
    const nextFn = vi.fn().mockRejectedValue(new AuthError());

    await errorHandler(c as any, nextFn as any);

    expect(jsonFn).toHaveBeenCalledWith(
      { error: "unauthenticated", code: "unauthenticated" },
      401,
    );
  });

  it("maps ForbiddenError to 403", async () => {
    const { c, jsonFn } = mockContext();
    const nextFn = vi.fn().mockRejectedValue(new ForbiddenError("Not allowed"));

    await errorHandler(c as any, nextFn as any);

    expect(jsonFn).toHaveBeenCalledWith(
      { error: "Not allowed", code: "forbidden" },
      403,
    );
  });

  it("maps NotFoundError to 404", async () => {
    const { c, jsonFn } = mockContext();
    const nextFn = vi.fn().mockRejectedValue(
      new NotFoundError("Tenant not found", "tenant_not_found"),
    );

    await errorHandler(c as any, nextFn as any);

    expect(jsonFn).toHaveBeenCalledWith(
      { error: "Tenant not found", code: "tenant_not_found" },
      404,
    );
  });

  it("maps ConflictError to 409", async () => {
    const { c, jsonFn } = mockContext();
    const nextFn = vi.fn().mockRejectedValue(
      new ConflictError("Already taken", "subdomain_taken"),
    );

    await errorHandler(c as any, nextFn as any);

    expect(jsonFn).toHaveBeenCalledWith(
      { error: "Already taken", code: "subdomain_taken" },
      409,
    );
  });

  it("maps GoneError to 410", async () => {
    const { c, jsonFn } = mockContext();
    const nextFn = vi.fn().mockRejectedValue(
      new GoneError("Link expired", "link_expired"),
    );

    await errorHandler(c as any, nextFn as any);

    expect(jsonFn).toHaveBeenCalledWith(
      { error: "Link expired", code: "link_expired" },
      410,
    );
  });

  it("maps LimitError to 429", async () => {
    const { c, jsonFn } = mockContext();
    const nextFn = vi.fn().mockRejectedValue(
      new LimitError("Too many links", "link_limit_reached"),
    );

    await errorHandler(c as any, nextFn as any);

    expect(jsonFn).toHaveBeenCalledWith(
      { error: "Too many links", code: "link_limit_reached" },
      429,
    );
  });

  it("maps DatabaseError to 503", async () => {
    const { c, jsonFn } = mockContext();
    const nextFn = vi.fn().mockRejectedValue(
      new DatabaseError("DB down", "service_unavailable"),
    );

    await errorHandler(c as any, nextFn as any);

    expect(jsonFn).toHaveBeenCalledWith(
      { error: "DB down", code: "service_unavailable" },
      503,
    );
  });

  // --- Unknown errors → 500 ---

  it("maps unknown errors to 500 with generic message", async () => {
    const { c, jsonFn } = mockContext();
    const nextFn = vi.fn().mockRejectedValue(new Error("Unexpected crash"));

    await errorHandler(c as any, nextFn as any);

    expect(jsonFn).toHaveBeenCalledWith(
      { error: "internal_error", code: "internal_error" },
      500,
    );
  });

  it("maps non-Error thrown values to 500", async () => {
    const { c, jsonFn } = mockContext();
    const nextFn = vi.fn().mockRejectedValue("string error");

    await errorHandler(c as any, nextFn as any);

    expect(jsonFn).toHaveBeenCalledWith(
      { error: "internal_error", code: "internal_error" },
      500,
    );
  });

  // --- No stack traces in response ---

  it("does not expose stack traces in the response body", async () => {
    const { c, jsonFn } = mockContext();
    const error = new Error("boom");
    error.stack = "Error: boom\n    at test.ts:1:2";
    const nextFn = vi.fn().mockRejectedValue(error);

    await errorHandler(c as any, nextFn as any);

    const responseBody = jsonFn.mock.calls[0]?.[0];
    expect(responseBody).toEqual(
      { error: "internal_error", code: "internal_error" },
    );
    // Stack trace should NOT be in the response
    expect(JSON.stringify(responseBody)).not.toContain("at test.ts");
  });

  // --- Custom AppError base class ---

  it("maps custom AppError to its status code", async () => {
    const { c, jsonFn } = mockContext();
    const nextFn = vi.fn().mockRejectedValue(
      new AppError("Custom error", "custom_code", 418),
    );

    await errorHandler(c as any, nextFn as any);

    expect(jsonFn).toHaveBeenCalledWith(
      { error: "Custom error", code: "custom_code" },
      418,
    );
  });
});
