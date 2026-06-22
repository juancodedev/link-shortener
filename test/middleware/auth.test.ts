import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock jose
// ---------------------------------------------------------------------------

vi.mock("jose", () => ({
  jwtVerify: vi.fn(),
}));

import { jwtVerify } from "jose";
import { auth } from "../../src/middleware/auth";

// ---------------------------------------------------------------------------
// Helper: create a mock Hono context
// ---------------------------------------------------------------------------

function mockContext(overrides: {
  authHeader?: string | null;
  jwtSecret?: string;
} = {}) {
  const setFn = vi.fn();
  const jsonFn = vi.fn().mockReturnValue(new Response(null, { status: 200 }));
  const headerFn = vi.fn().mockReturnValue(overrides.authHeader ?? null);

  const c = {
    req: {
      header: headerFn,
    },
    env: {
      SUPABASE_JWT_SECRET: overrides.jwtSecret ?? "test-jwt-secret",
    },
    set: setFn,
    json: jsonFn,
    executionCtx: {
      waitUntil: vi.fn(),
    },
  };

  const nextFn = vi.fn().mockResolvedValue(undefined);

  return { c, setFn, jsonFn, nextFn, headerFn };
}

// ---------------------------------------------------------------------------
// Auth middleware tests (REQ-T002 auth failure)
// ---------------------------------------------------------------------------

describe("auth middleware", () => {
  const mockPayload = {
    sub: "user-uuid-123",
    email: "user@example.com",
    exp: Math.floor(Date.now() / 1000) + 3600,
    aud: "authenticated",
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sets user context for a valid JWT token", async () => {
    vi.mocked(jwtVerify).mockResolvedValueOnce({
      payload: mockPayload,
      protectedHeader: {} as any,
    });

    const { c, setFn, nextFn, headerFn } = mockContext({
      authHeader: "Bearer valid-token",
    });

    await auth(c as any, nextFn as any);

    expect(headerFn).toHaveBeenCalledWith("Authorization");
    expect(jwtVerify).toHaveBeenCalledWith(
      "valid-token",
      expect.any(Uint8Array),
      expect.objectContaining({
        audience: "authenticated",
        clockTolerance: 5,
      }),
    );
    expect(setFn).toHaveBeenCalledWith("user", {
      userId: "user-uuid-123",
      email: "user@example.com",
    });
    expect(nextFn).toHaveBeenCalled();
  });

  it("returns 401 when Authorization header is missing", async () => {
    const { c, jsonFn, nextFn } = mockContext({
      authHeader: null,
    });

    await auth(c as any, nextFn as any);

    expect(jsonFn).toHaveBeenCalledWith({ error: "unauthenticated" }, 401);
    expect(nextFn).not.toHaveBeenCalled();
  });

  it("returns 401 when Authorization header lacks Bearer prefix", async () => {
    const { c, jsonFn, nextFn } = mockContext({
      authHeader: "Basic some-token",
    });

    await auth(c as any, nextFn as any);

    expect(jsonFn).toHaveBeenCalledWith({ error: "unauthenticated" }, 401);
    expect(nextFn).not.toHaveBeenCalled();
  });

  it("returns 401 for an expired token", async () => {
    vi.mocked(jwtVerify).mockRejectedValueOnce(
      new Error("JWT expired"),
    );

    const { c, jsonFn, nextFn } = mockContext({
      authHeader: "Bearer expired-token",
    });

    await auth(c as any, nextFn as any);

    expect(jsonFn).toHaveBeenCalledWith({ error: "unauthenticated" }, 401);
    expect(nextFn).not.toHaveBeenCalled();
  });

  it("returns 401 for a token with invalid signature", async () => {
    vi.mocked(jwtVerify).mockRejectedValueOnce(
      new Error("signature verification failed"),
    );

    const { c, jsonFn, nextFn } = mockContext({
      authHeader: "Bearer bad-signature",
    });

    await auth(c as any, nextFn as any);

    expect(jsonFn).toHaveBeenCalledWith({ error: "unauthenticated" }, 401);
    expect(nextFn).not.toHaveBeenCalled();
  });

  it("returns 401 when JWT payload has no sub claim", async () => {
    vi.mocked(jwtVerify).mockResolvedValueOnce({
      payload: { email: "user@example.com" }, // No sub
      protectedHeader: {} as any,
    });

    const { c, jsonFn, nextFn } = mockContext({
      authHeader: "Bearer no-sub-token",
    });

    await auth(c as any, nextFn as any);

    expect(jsonFn).toHaveBeenCalledWith({ error: "unauthenticated" }, 401);
    expect(nextFn).not.toHaveBeenCalled();
  });
});
