import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock db/client
// ---------------------------------------------------------------------------

vi.mock("../src/db/client", () => ({
  withClient: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock cache modules (every export used by the router-mounted handlers)
//
// The factories must mirror what src/handlers/redirect.ts and src/api/links.ts
// actually import. A missing export resolves to undefined, so the first call
// site that reaches it throws and the handler turns it into a 503.
// ---------------------------------------------------------------------------

vi.mock("../src/cache/shortcode", () => ({
  setCachedUrl: vi.fn().mockResolvedValue(undefined),
  invalidateCachedUrl: vi.fn().mockResolvedValue(undefined),
  getCachedUrl: vi.fn().mockResolvedValue(null),
  getCachedRegistryEntry: vi.fn().mockResolvedValue(null),
  setCachedRegistryEntry: vi.fn().mockResolvedValue(undefined),
  invalidateCachedRegistryEntry: vi.fn().mockResolvedValue(undefined),
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
  createTenantMembershipMiddleware: vi.fn(() =>
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

/**
 * Mocks the two-statement cold path behind `GET /:code`: the registry join, then
 * the link row in whatever tenant schema the registry named. Routing by SQL shape
 * keeps the tests readable when a statement is added.
 */
function mockFlatShortLinkDb(opts: { links?: unknown[] } = {}) {
  const sql: string[] = [];

  vi.mocked(withClient).mockImplementation(async (_env: any, fn: any) =>
    fn({
      query: vi.fn().mockImplementation(async (text: string) => {
        sql.push(text);
        if (text.includes("short_code_registry")) {
          return {
            rows: [
              {
                short_code: "VHvuSpP",
                link_id: "link-uuid",
                tenant_id: "tenant-uuid",
                schema_name: "tenant_a7f3",
                salt: "salt-abc",
                subdomain: "acme",
              },
            ],
            rowCount: 1,
          };
        }
        const links = opts.links ?? [
          { id: "link-uuid", original_url: "https://example.com", is_active: true, expires_at: null },
        ];
        return { rows: links, rowCount: links.length };
      }),
    }),
  );

  return { sql };
}

/** app.request() needs an executionCtx because several handlers use waitUntil. */
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
// Flat short links (T3.3, T3.4)
//
// Public links are now `/:code`. That makes Hono's precedence rule load-bearing:
// a static single-segment route must win over the catch-all, or /dashboard would
// be read as a short code and 404. These tests assert the routing outcome, not
// the registration order, because outcome is the contract.
// ---------------------------------------------------------------------------

describe("flat short link routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registers the catch-all short-code route", () => {
    const app = createApp(testEnv());

    expect(app.routes.some((r) => r.path === "/:code")).toBe(true);
  });

  it("registers the catch-all after every static route it must not shadow", () => {
    const app = createApp(testEnv());
    const paths = app.routes.map((r) => r.path);
    const catchAll = paths.indexOf("/:code");

    for (const path of ["/signup", "/login", "/reset-password", "/auth/callback", "/dashboard", "/"]) {
      expect(paths.indexOf(path)).toBeGreaterThanOrEqual(0);
      expect(paths.indexOf(path)).toBeLessThan(catchAll);
    }
  });

  it("no longer registers the tenant-scoped /r/:tenant/:code route", async () => {
    const app = createApp(testEnv());

    expect(app.routes.some((r) => r.path === "/r/:tenant/:code")).toBe(false);

    // And nothing answers it: a removed route is a 404, not a redirect.
    const res = await app.request(
      "/r/links/VHvuSpP",
      { method: "GET" },
      testEnv(),
      executionCtx,
    );

    expect(res.status).toBe(404);
  });

  it.each([
    ["/dashboard", "Dashboard"],
    ["/login", "Log In"],
    ["/signup", "Sign Up"],
    ["/reset-password", "Reset Password"],
  ])("%s still reaches its own handler instead of /:code", async (path, marker) => {
    // These handlers render HTML and touch no database, so an unmocked env is
    // enough: if /:code had won, the request would have gone to the registry.
    const app = createApp(testEnv());
    const res = await app.request(path, { method: "GET" }, testEnv(), executionCtx);

    expect(res.status).toBe(200);
    expect(await res.text()).toContain(marker);
    expect(withClient).not.toHaveBeenCalled();
  });

  it("routes an unregistered single-segment path to /:code", async () => {
    mockFlatShortLinkDb();

    const app = createApp(testEnv());
    const res = await app.request(
      "/VHvuSpP",
      { method: "GET" },
      testEnv(),
      executionCtx,
    );

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://example.com");
  });

  it("404s an unknown single-segment path without querying a tenant schema", async () => {
    const { sql } = mockFlatShortLinkDb({ links: [] });

    const app = createApp(testEnv());
    const res = await app.request(
      "/nosuchcod",
      { method: "GET" },
      testEnv(),
      executionCtx,
    );

    expect(res.status).toBe(404);
    // Resolution went through the registry and stopped there.
    expect(sql[0]).toContain("public.short_code_registry");
    expect(sql.some((s) => s.includes(".links"))).toBe(false);
  });
});

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
// GET /api/clients/metrics — the per-client_ref rollup's own route
//
// This exists because the rollup used to ride inside GET /api/links, which
// turned that response from a bare array into an envelope. The route and its
// middleware chain are load-bearing twice over: the endpoint must be reachable
// at all, and it must be registered behind the SAME auth → tenant chain as every
// other tenant-scoped route, because that chain is what puts a tenant schema in
// context and the rollup joins against exactly that schema.
// ---------------------------------------------------------------------------

describe("router client metrics route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registers GET /api/clients/metrics", () => {
    const app = createApp(testEnv());

    const distinct = new Set(app.routes.map((r) => `${r.method} ${r.path}`));

    expect(distinct.has("GET /api/clients/metrics")).toBe(true);
  });

  it("registers it with auth and the tenant middleware, like the other tenant-scoped routes", () => {
    const app = createApp(testEnv());

    // Hono flattens each registered chain into one entry per handler, so the
    // chain length is the assertion: three means auth, tenant middleware, and
    // the handler. Registering with `auth` alone would leave `c.get("tenant")`
    // undefined and the rollup would join against nothing.
    const chainFor = (method: string, path: string) =>
      app.routes.filter((r) => r.method === method && r.path === path);

    expect(chainFor("GET", "/api/clients/metrics")).toHaveLength(3);

    // Same chain length as the routes it must match.
    expect(chainFor("GET", "/api/links")).toHaveLength(3);
    expect(chainFor("GET", "/api/links/:id/clicks")).toHaveLength(3);
  });

  it("routes GET /api/clients/metrics through to the rollup handler", async () => {
    const sql: string[] = [];
    vi.mocked(withClient).mockImplementation(async (_env: any, fn: any) =>
      fn({
        query: vi.fn().mockImplementation(async (text: string) => {
          sql.push(text);
          return {
            rows: [{ client_ref: "ACME-0042", unique_visitors: 30, sessions: 42 }],
            rowCount: 1,
          };
        }),
      }),
    );

    const app = createApp(testEnv());
    const res = await app.request(
      "/api/clients/metrics",
      { method: "GET" },
      testEnv(),
      executionCtx,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual([
      { client_ref: "ACME-0042", unique_visitors: 30, sessions: 42 },
    ]);
    // End to end proof the tenant middleware ran: the query names the tenant
    // schema that middleware put in context.
    expect(sql[0]).toContain('"tenant_a7f3"."links"');
  });

  it("leaves GET /api/links a bare array while the rollup lives on its own route", async () => {
    vi.mocked(withClient).mockImplementation(async (_env: any, fn: any) =>
      fn({ query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }) }),
    );

    const app = createApp(testEnv());
    const res = await app.request(
      "/api/links",
      { method: "GET" },
      testEnv(),
      executionCtx,
    );

    expect(res.status).toBe(200);
    // Through the real app, so this asserts the wire format rather than what a
    // handler passed to c.json.
    await expect(res.json()).resolves.toEqual([]);
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
      // Was "original_url is required", which was never true: 12345 was
      // PRESENT, and said nothing about whether a URL is required. The field
      // is optional now, so this reports the actual defect instead.
      error: "original_url must be a string",
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