import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock db/client
// ---------------------------------------------------------------------------

vi.mock("../src/db/client", () => ({
  withClient: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock cache modules (both exports used by the router-mounted handlers)
// ---------------------------------------------------------------------------

vi.mock("../src/cache/shortcode", () => ({
  setCachedUrl: vi.fn().mockResolvedValue(undefined),
  invalidateCachedUrl: vi.fn().mockResolvedValue(undefined),
  getCachedUrl: vi.fn().mockResolvedValue(null),
}));

// ---------------------------------------------------------------------------
// Mock auth middleware — pass-through so route wiring is under test
// ---------------------------------------------------------------------------

vi.mock("../src/middleware/auth", () => ({
  auth: vi.fn().mockImplementation(async (c: any, next: any) => {
    c.set("user", { userId: "user-uuid", email: "dev@example.com" });
    await next();
  }),
}));

// ---------------------------------------------------------------------------
// Mock tenant middleware factory — pass-through that seeds a tenant
// ---------------------------------------------------------------------------

vi.mock("../src/middleware/tenant", () => ({
  createUserProfileTenantMiddleware: vi.fn(() =>
    vi.fn(async (c: any, next: any) => {
      c.set("tenant", {
        tenantSlug: "acme",
        schemaName: "tenant_a7f3",
        tenantId: "tenant-uuid",
      });
      await next();
    }),
  ),
}));

import { withClient } from "../src/db/client";
import { invalidateCachedUrl } from "../src/cache/shortcode";
import { createApp } from "../src/router";
import { deleteLink } from "../src/api/links";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function testEnv(): any {
  return {
    SHORT_URL_DOMAIN: "short.link",
    SUPABASE_JWT_SECRET: "test-secret",
    SUPABASE_URL: "https://test.supabase.co",
    SUPABASE_ANON_KEY: "test-anon-key",
    SUPABASE_SERVICE_ROLE_KEY: "test-service-key",
    SHORT_URL_CACHE: {} as any,
    TENANT_CACHE: {} as any,
  };
}

/** Mocks the DELETE ... RETURNING short_code statement. */
function mockDeleteRows(rows: unknown[]) {
  return vi.mocked(withClient).mockImplementation(async (_env: any, fn: any) =>
    fn({ query: vi.fn().mockResolvedValue({ rows, rowCount: rows.length }) }),
  );
}

/** Makes every withClient call reject with the given error (unknown-error path). */
function mockClientThrows(err: unknown) {
  return vi.mocked(withClient).mockRejectedValue(err);
}

/** app.request() needs an executionCtx because deleteLink uses waitUntil. */
const executionCtx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() };

/** Minimal Hono context for calling deleteLink directly. */
function mockDeleteContext() {
  const waitUntilFn = vi.fn();
  const c = {
    req: { param: vi.fn().mockReturnValue("missing-link") },
    env: testEnv(),
    get: vi.fn().mockReturnValue({
      tenantSlug: "acme",
      schemaName: "tenant_a7f3",
      tenantId: "tenant-uuid",
    }),
    executionCtx: { waitUntil: waitUntilFn },
  };
  return { c, waitUntilFn };
}

// ---------------------------------------------------------------------------
// Router route-registration tests
// ---------------------------------------------------------------------------

describe("router link routes", () => {
  it("registers DELETE /api/links/:id so the dashboard delete button is reachable", () => {
    const app = createApp(testEnv());

    // Hono records one entry per handler in the chain, so compare the
    // distinct method+path pairs rather than raw entry count.
    const distinct = new Set(
      app.routes.map((r) => `${r.method} ${r.path}`),
    );

    expect(distinct.has("DELETE /api/links/:id")).toBe(true);
  });

  it("registers DELETE alongside the existing PATCH on /api/links/:id", () => {
    const app = createApp(testEnv());

    const methods = new Set(
      app.routes
        .filter((r) => r.path === "/api/links/:id")
        .map((r) => r.method),
    );

    expect(methods).toContain("PATCH");
    expect(methods).toContain("DELETE");
  });

  it("routes DELETE /api/links/:id through to the delete handler", async () => {
    mockDeleteRows([{ short_code: "abc1234" }]);

    const app = createApp(testEnv());
    const res = await app.request(
      "/api/links/link-uuid",
      { method: "DELETE" },
      testEnv(),
      executionCtx,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
    expect(withClient).toHaveBeenCalled();
    // KV cache invalidated for the deleted code
    expect(invalidateCachedUrl).toHaveBeenCalledWith(
      expect.anything(),
      "acme",
      "abc1234",
    );
  });

  it("propagates NotFound from deleteLink when no row matches", async () => {
    // Handler-level contract. The end-to-end 404 mapping over the real app is
    // covered in the "error handling" suite below.
    mockDeleteRows([]);

    const { c, waitUntilFn } = mockDeleteContext();

    await expect(deleteLink(c as any)).rejects.toThrow("not found");
    expect(withClient).toHaveBeenCalled();
    expect(waitUntilFn).not.toHaveBeenCalled();
  });

  it("keeps POST and GET on the collection route", () => {
    const app = createApp(testEnv());

    const collection = new Set(
      app.routes.filter((r) => r.path === "/api/links").map((r) => r.method),
    );

    expect(collection).toContain("POST");
    expect(collection).toContain("GET");
  });
});

// ---------------------------------------------------------------------------
// Error-handling integration tests (REQ-O001)
//
// These go through the REAL createApp so they prove Hono actually reaches our
// error handler. A pure unit test of the mapping function is not enough: a
// `app.use("*", errorHandler)` middleware cannot observe downstream throws
// because Hono's `compose` installs its own `catch` on the frame that invokes
// the throwing handler, one level below the middleware.
// ---------------------------------------------------------------------------

describe("error handling through the real app", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("maps NotFoundError to a 404 JSON body", async () => {
    mockDeleteRows([]);

    const app = createApp(testEnv());
    const res = await app.request(
      "/api/links/link-uuid",
      { method: "DELETE" },
      testEnv(),
      executionCtx,
    );

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({
      error: "Link not found",
      code: "not_found",
    });
  });

  it("maps ValidationError to a 400 JSON body", async () => {
    const app = createApp(testEnv());
    const res = await app.request(
      "/api/links",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ original_url: 12345 }),
      },
      testEnv(),
      executionCtx,
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: "original_url is required",
      code: "invalid_request",
    });
  });

  it("maps a malformed JSON body to a 400 JSON body", async () => {
    const app = createApp(testEnv());
    const res = await app.request(
      "/api/links",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{not json",
      },
      testEnv(),
      executionCtx,
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: "Invalid JSON body",
      code: "invalid_request",
    });
  });

  it("maps ConflictError to a 409 JSON body", async () => {
    // Subdomain uniqueness check reports the slug is already taken.
    mockDeleteRows([{ exists: true }]);

    const app = createApp(testEnv());
    const res = await app.request(
      "/api/tenants",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subdomain: "acme", display_name: "Acme" }),
      },
      testEnv(),
      executionCtx,
    );

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({
      error: 'Subdomain "acme" is already taken',
      code: "subdomain_taken",
    });
  });

  it("maps ForbiddenError to a 403 JSON body", async () => {
    // Tenant row comes back owned by somebody else.
    mockDeleteRows([
      {
        id: "tenant-uuid",
        schema_name: "tenant_a7f3",
        subdomain: "acme",
        owner_id: "another-user",
      },
    ]);

    const app = createApp(testEnv());
    const res = await app.request(
      "/api/tenants/tenant-uuid",
      { method: "DELETE" },
      testEnv(),
      executionCtx,
    );

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({
      error: "You are not the owner of this tenant",
      code: "forbidden",
    });
  });

  it("maps an unknown thrown error to a 500 JSON body with no stack leak", async () => {
    mockClientThrows(new Error("pool exhausted at db/client.ts:42:9"));

    const app = createApp(testEnv());
    const res = await app.request(
      "/api/links/link-uuid",
      { method: "DELETE" },
      testEnv(),
      executionCtx,
    );

    expect(res.status).toBe(500);

    // REQ-O001: neither the stack nor the internal message may leak out.
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({
      error: "internal_error",
      code: "internal_error",
    });
    expect(text).not.toContain("at db/client.ts");
    expect(text).not.toContain("pool exhausted");
    expect(text).not.toContain("Error:");
  });

  it("does not return Hono's default text/plain 500 for handler throws", async () => {
    mockDeleteRows([]);

    const app = createApp(testEnv());
    const res = await app.request(
      "/api/links/link-uuid",
      { method: "DELETE" },
      testEnv(),
      executionCtx,
    );

    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    await expect(res.text()).resolves.not.toContain("Internal Server Error");
  });
});