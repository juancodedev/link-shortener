import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { auth } from "../../src/middleware/auth";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Builds a Supabase Auth API response body. */
function authUserResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: "user-uuid-123",
    email: "user@example.com",
    aud: "authenticated",
    ...overrides,
  };
}

/** Builds a mock Hono context with the env bindings auth.ts actually reads. */
function mockContext(overrides: { authHeader?: string | null } = {}) {
  const setFn = vi.fn();
  const jsonFn = vi.fn().mockReturnValue(new Response(null, { status: 200 }));
  const headerFn = vi.fn().mockReturnValue(overrides.authHeader ?? null);

  const c = {
    req: {
      header: headerFn,
    },
    env: {
      // auth.ts calls `${c.env.SUPABASE_URL}/auth/v1/user` and sends
      // `apikey: c.env.SUPABASE_ANON_KEY`. A missing SUPABASE_URL makes the
      // template literal produce "undefined/auth/v1/user", which throws
      // TypeError: Invalid URL inside the handler's catch block.
      SUPABASE_URL: "https://test.supabase.co",
      SUPABASE_ANON_KEY: "test-anon-key",
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
//
// src/middleware/auth.ts delegates token verification to the Supabase Auth API
// (GET /auth/v1/user) instead of local `jose.jwtVerify` signature checks. These
// tests therefore stub the network boundary, not a crypto library: the token's
// validity is entirely the Auth API's verdict (res.ok) plus the presence of an
// `id` in the returned user object.
// ---------------------------------------------------------------------------

describe("auth middleware", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sets user context for a valid token", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(authUserResponse()), { status: 200 }),
    );

    const { c, setFn, nextFn, headerFn } = mockContext({
      authHeader: "Bearer valid-token",
    });

    await auth(c as any, nextFn as any);

    expect(headerFn).toHaveBeenCalledWith("Authorization");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://test.supabase.co/auth/v1/user",
      {
        headers: {
          Authorization: "Bearer valid-token",
          apikey: "test-anon-key",
        },
      },
    );
    expect(setFn).toHaveBeenCalledWith("user", {
      userId: "user-uuid-123",
      email: "user@example.com",
    });
    expect(nextFn).toHaveBeenCalled();
  });

  it("falls back to an empty email when the Auth API omits it", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(authUserResponse({ email: undefined })), {
        status: 200,
      }),
    );

    const { c, setFn, nextFn } = mockContext({
      authHeader: "Bearer valid-token",
    });

    await auth(c as any, nextFn as any);

    expect(setFn).toHaveBeenCalledWith("user", {
      userId: "user-uuid-123",
      email: "",
    });
    expect(nextFn).toHaveBeenCalled();
  });

  it("returns 401 when Authorization header is missing", async () => {
    const { c, jsonFn, nextFn } = mockContext({
      authHeader: null,
    });

    await auth(c as any, nextFn as any);

    expect(jsonFn).toHaveBeenCalledWith({ error: "unauthenticated" }, 401);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(nextFn).not.toHaveBeenCalled();
  });

  it("returns 401 when Authorization header lacks Bearer prefix", async () => {
    const { c, jsonFn, nextFn } = mockContext({
      authHeader: "Basic some-token",
    });

    await auth(c as any, nextFn as any);

    expect(jsonFn).toHaveBeenCalledWith({ error: "unauthenticated" }, 401);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(nextFn).not.toHaveBeenCalled();
  });

  it("returns 401 for an expired token", async () => {
    // An expired token is rejected by the Auth API with a non-ok status.
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: "Token is expired" }), {
        status: 401,
      }),
    );

    const { c, setFn, jsonFn, nextFn } = mockContext({
      authHeader: "Bearer expired-token",
    });

    await auth(c as any, nextFn as any);

    expect(jsonFn).toHaveBeenCalledWith({ error: "unauthenticated" }, 401);
    expect(setFn).not.toHaveBeenCalled();
    expect(nextFn).not.toHaveBeenCalled();
  });

  it("returns 401 for a token with invalid signature", async () => {
    // An invalid signature is likewise rejected by the Auth API (401). The
    // middleware no longer distinguishes "expired" from "bad signature"
    // locally — both are just a non-ok response from /auth/v1/user.
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: "invalid signature" }), {
        status: 401,
      }),
    );

    const { c, setFn, jsonFn, nextFn } = mockContext({
      authHeader: "Bearer bad-signature",
    });

    await auth(c as any, nextFn as any);

    expect(jsonFn).toHaveBeenCalledWith({ error: "unauthenticated" }, 401);
    expect(setFn).not.toHaveBeenCalled();
    expect(nextFn).not.toHaveBeenCalled();
  });

  it("returns 401 when the user payload has no id claim", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ email: "user@example.com" }), // No id / sub
        { status: 200 },
      ),
    );

    const { c, setFn, jsonFn, nextFn } = mockContext({
      authHeader: "Bearer no-sub-token",
    });

    await auth(c as any, nextFn as any);

    expect(jsonFn).toHaveBeenCalledWith({ error: "unauthenticated" }, 401);
    expect(setFn).not.toHaveBeenCalled();
    expect(nextFn).not.toHaveBeenCalled();
  });
});