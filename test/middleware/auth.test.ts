import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SignJWT } from "jose";

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
function mockContext(
  overrides: { authHeader?: string | null; jwtSecret?: string } = {},
) {
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
      // Left out by default so the pre-existing suite exercises the HTTP
      // fallback path unchanged. The local-verification suite opts in.
      ...(overrides.jwtSecret ? { SUPABASE_JWT_SECRET: overrides.jwtSecret } : {}),
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

const TEST_JWT_SECRET = "super-secret-jwt-token-with-at-least-32-characters";

/** Signs a real HS256 JWT the way Supabase signs its access tokens. */
async function signAccessToken(
  claims: Record<string, unknown> = {},
  secret = TEST_JWT_SECRET,
): Promise<string> {
  return new SignJWT({ email: "user@example.com", ...claims })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject("user-uuid-123")
    .setAudience("authenticated")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(secret));
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

// ---------------------------------------------------------------------------
// Local JWT verification (T0.1)
//
// The middleware verifies a Supabase access token locally with HS256 when
// SUPABASE_JWT_SECRET is configured, removing one network hop from every
// authenticated request. When local verification is unavailable or fails, it
// falls back to the Supabase Auth API — the behaviour the suite above pins.
//
// The fallback is deliberate and load-bearing: a deployment with a wrong or
// stale SUPABASE_JWT_SECRET would otherwise 401 every real user, and a
// hard-fail path turns a misconfiguration into a total lockout.
// ---------------------------------------------------------------------------

describe("auth middleware — local JWT verification", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("verifies locally and makes no network call when the secret is configured", async () => {
    const token = await signAccessToken();

    const { c, setFn, nextFn } = mockContext({
      authHeader: `Bearer ${token}`,
      jwtSecret: TEST_JWT_SECRET,
    });

    await auth(c as any, nextFn as any);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(setFn).toHaveBeenCalledWith("user", {
      userId: "user-uuid-123",
      email: "user@example.com",
    });
    expect(nextFn).toHaveBeenCalled();
  });

  it("falls back to an empty email when the token omits it", async () => {
    const token = await signAccessToken({ email: undefined });

    const { c, setFn, nextFn } = mockContext({
      authHeader: `Bearer ${token}`,
      jwtSecret: TEST_JWT_SECRET,
    });

    await auth(c as any, nextFn as any);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(setFn).toHaveBeenCalledWith("user", {
      userId: "user-uuid-123",
      email: "",
    });
    expect(nextFn).toHaveBeenCalled();
  });

  it("falls back to the Auth API when local verification fails", async () => {
    // A token signed with the wrong secret. Local verification cannot pass,
    // and the middleware must not lock the user out over a bad secret.
    const token = await signAccessToken({}, "a-different-secret-entirely");

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(authUserResponse()), { status: 200 }),
    );

    const { c, setFn, nextFn } = mockContext({
      authHeader: `Bearer ${token}`,
      jwtSecret: TEST_JWT_SECRET,
    });

    await auth(c as any, nextFn as any);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://test.supabase.co/auth/v1/user",
      {
        headers: {
          Authorization: `Bearer ${token}`,
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

  it("returns 401 when local verification fails and the Auth API rejects the token", async () => {
    const token = await signAccessToken({}, "a-different-secret-entirely");

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: "invalid signature" }), {
        status: 401,
      }),
    );

    const { c, jsonFn, setFn, nextFn } = mockContext({
      authHeader: `Bearer ${token}`,
      jwtSecret: TEST_JWT_SECRET,
    });

    await auth(c as any, nextFn as any);

    expect(jsonFn).toHaveBeenCalledWith({ error: "unauthenticated" }, 401);
    expect(setFn).not.toHaveBeenCalled();
    expect(nextFn).not.toHaveBeenCalled();
  });

  it("returns 401 for an expired token without trusting the Auth API", async () => {
    const expired = await new SignJWT({ email: "user@example.com" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("user-uuid-123")
      .setAudience("authenticated")
      .setExpirationTime("-1h")
      .sign(new TextEncoder().encode(TEST_JWT_SECRET));

    // The Auth API would also reject it, but an expired token is a definitive
    // local verdict — there is nothing for a network call to add.
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify(authUserResponse()), { status: 200 }),
    );

    const { c, jsonFn, setFn, nextFn } = mockContext({
      authHeader: `Bearer ${expired}`,
      jwtSecret: TEST_JWT_SECRET,
    });

    await auth(c as any, nextFn as any);

    expect(jsonFn).toHaveBeenCalledWith({ error: "unauthenticated" }, 401);
    expect(setFn).not.toHaveBeenCalled();
    expect(nextFn).not.toHaveBeenCalled();
  });

  it("rejects a token whose audience is not 'authenticated'", async () => {
    // The anon/publishable key is also an HS256 JWT signed with the same
    // secret. Accepting it would let the publishable key impersonate a user.
    const anonToken = await new SignJWT({ email: "user@example.com" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("user-uuid-123")
      .setAudience("anon")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode(TEST_JWT_SECRET));

    fetchMock.mockResolvedValue(
      new Response(JSON.stringify(authUserResponse()), { status: 200 }),
    );

    const { c, jsonFn, setFn, nextFn } = mockContext({
      authHeader: `Bearer ${anonToken}`,
      jwtSecret: TEST_JWT_SECRET,
    });

    await auth(c as any, nextFn as any);

    expect(jsonFn).toHaveBeenCalledWith({ error: "unauthenticated" }, 401);
    expect(setFn).not.toHaveBeenCalled();
    expect(nextFn).not.toHaveBeenCalled();
  });
});