import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock cache modules
// ---------------------------------------------------------------------------

//
// The mock must mirror the exports `src/middleware/tenant.ts` actually imports
// (`getCachedSchema` / `setCachedTenant` — see src/middleware/tenant.ts:5). A
// factory that only provides the legacy pair makes the imported bindings
// undefined, so `setCachedTenant` throws "No export is defined on the mock" and
// the broad catch turns the request into a misleading 503.
// ---------------------------------------------------------------------------

vi.mock("../../src/cache/tenant", () => ({
  getCachedSchema: vi.fn().mockResolvedValue(null),
  setCachedTenant: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Mock db/client
// ---------------------------------------------------------------------------

vi.mock("../../src/db/client", () => ({
  withClient: vi.fn(),
}));

import { getCachedSchema } from "../../src/cache/tenant";
import { withClient } from "../../src/db/client";
import {
  createTenantMiddleware,
  createTenantMembershipMiddleware,
  PathBasedStrategy,
} from "../../src/middleware/tenant";

// ---------------------------------------------------------------------------
// Helper: mock Hono context
// ---------------------------------------------------------------------------

function mockContext(overrides: {
  tenantParam?: string;
  user?: { userId: string; email: string };
} = {}) {
  const setFn = vi.fn();
  const jsonFn = vi.fn().mockImplementation(
    (body: unknown, status: number) => new Response(JSON.stringify(body), { status }),
  );
  const getFn = vi.fn();

  if (overrides.user) {
    getFn.mockImplementation((key: string) => {
      if (key === "user") return overrides.user;
      return undefined;
    });
  }

  const waitUntilFn = vi.fn();

  const c = {
    req: {
      param: vi.fn().mockReturnValue(overrides.tenantParam ?? ""),
      header: vi.fn((name: string) =>
        name === "X-Tenant-Slug" ? (overrides.tenantHeader ?? undefined) : undefined,
      ),
      query: vi.fn((name: string) =>
        name === "tenant" ? (overrides.tenantQuery ?? undefined) : undefined,
      ),
    },
    env: {
      SUPABASE_JWT_SECRET: "test-secret",
      SUPABASE_URL: "https://test.supabase.co",
      SUPABASE_ANON_KEY: "test-anon-key",
      SUPABASE_SERVICE_ROLE_KEY: "test-service-key",
    },
    set: setFn,
    get: getFn,
    json: jsonFn,
    executionCtx: {
      waitUntil: waitUntilFn,
    },
  };

  const nextFn = vi.fn().mockResolvedValue(undefined);

  return { c, setFn, jsonFn, nextFn, getFn, waitUntilFn };
}

// ---------------------------------------------------------------------------
// Path-based tenant middleware tests (REQ-R002)
// ---------------------------------------------------------------------------

describe("createTenantMiddleware (path-based)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses cached schema on KV hit", async () => {
    vi.mocked(getCachedSchema).mockResolvedValueOnce("tenant_a7f3");

    const { c, setFn, nextFn } = mockContext({ tenantParam: "acme" });
    const middleware = createTenantMiddleware(new PathBasedStrategy());

    await middleware(c as any, nextFn as any);

    expect(getCachedSchema).toHaveBeenCalledWith(c.env, "acme");
    expect(setFn).toHaveBeenCalledWith("tenant", {
      tenantSlug: "acme",
      schemaName: "tenant_a7f3",
      tenantId: "",
      tenantSalt: "",
    });
    expect(nextFn).toHaveBeenCalled();
  });

  it("queries DB on KV miss and populates cache", async () => {
    vi.mocked(getCachedSchema).mockResolvedValueOnce(null); // KV miss

    vi.mocked(withClient).mockImplementationOnce(async (_env: any, fn: any) => {
      return fn({
        query: vi.fn().mockResolvedValueOnce({
          rows: [{ id: "tenant-uuid", schema_name: "tenant_b12d", salt: "salt-abc" }],
        }),
      });
    });

    const { c, setFn, nextFn, waitUntilFn } = mockContext({ tenantParam: "acme" });
    const middleware = createTenantMiddleware(new PathBasedStrategy());

    await middleware(c as any, nextFn as any);

    expect(getCachedSchema).toHaveBeenCalled();
    expect(withClient).toHaveBeenCalled();
    expect(setFn).toHaveBeenCalledWith("tenant", {
      tenantSlug: "acme",
      schemaName: "tenant_b12d",
      tenantId: "tenant-uuid",
      tenantSalt: "salt-abc",
    });
    // KV population is fire-and-forget via waitUntil
    expect(waitUntilFn).toHaveBeenCalled();
    expect(nextFn).toHaveBeenCalled();
  });

  it("returns 404 for unknown tenant", async () => {
    vi.mocked(getCachedSchema).mockResolvedValueOnce(null);

    vi.mocked(withClient).mockImplementationOnce(async (_env: any, fn: any) => {
      return fn({
        query: vi.fn().mockResolvedValueOnce({ rows: [] }),
      });
    });

    const { c, jsonFn, nextFn } = mockContext({ tenantParam: "nonexistent" });
    const middleware = createTenantMiddleware(new PathBasedStrategy());

    await middleware(c as any, nextFn as any);

    expect(jsonFn).toHaveBeenCalledWith({ error: "tenant_not_found" }, 404);
    expect(nextFn).not.toHaveBeenCalled();
  });

  it("returns 503 on database connection failure", async () => {
    vi.mocked(getCachedSchema).mockResolvedValueOnce(null);

    vi.mocked(withClient).mockRejectedValueOnce(new Error("connection refused"));

    const { c, jsonFn, nextFn } = mockContext({ tenantParam: "acme" });
    const middleware = createTenantMiddleware(new PathBasedStrategy());

    await middleware(c as any, nextFn as any);

    expect(jsonFn).toHaveBeenCalledWith(
      { error: "service_unavailable" },
      503,
    );
    expect(nextFn).not.toHaveBeenCalled();
  });

  it("returns 404 for empty slug", async () => {
    const { c, jsonFn, nextFn } = mockContext({ tenantParam: "" });
    const middleware = createTenantMiddleware(new PathBasedStrategy());

    await middleware(c as any, nextFn as any);

    expect(jsonFn).toHaveBeenCalledWith({ error: "tenant_not_found" }, 404);
    expect(nextFn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// User-profile tenant middleware tests
// ---------------------------------------------------------------------------

describe("createTenantMembershipMiddleware", () => {
  /** A membership row as the join returns it. */
  const row = (slug: string, id = `tenant-${slug}`) => ({
    id,
    schema_name: `tenant_${slug}`,
    subdomain: slug,
    salt: `salt-${slug}`,
    role: "owner",
  });

  /** Answers the join with the given rows and captures the SQL + params. */
  function memberships(rows: unknown[]) {
    const seen: { sql: string; params?: unknown[] }[] = [];
    vi.mocked(withClient).mockImplementation(async (_env: any, fn: any) =>
      fn({
        query: vi.fn().mockImplementation((sql: string, params?: unknown[]) => {
          seen.push({ sql, params });
          return Promise.resolve({ rows });
        }),
      }),
    );
    return seen;
  }

  const asUser = () => ({
    user: { userId: "user-123", email: "user@test.com" },
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves the tenant from memberships", async () => {
    memberships([row("testco", "tenant-uuid")]);
    const { c, setFn, nextFn, waitUntilFn } = mockContext(asUser());

    await createTenantMembershipMiddleware()(c as any, nextFn as any);

    expect(setFn).toHaveBeenCalledWith("tenant", {
      tenantSlug: "testco",
      schemaName: "tenant_testco",
      tenantId: "tenant-uuid",
      tenantSalt: "salt-testco",
      membershipRole: "owner",
    });
    expect(waitUntilFn).toHaveBeenCalled();
    expect(nextFn).toHaveBeenCalled();
  });

  // The whole point of the phase: the predicate that grants access lives in
  // the SQL. A resolver that fetched broadly and filtered in JavaScript would
  // be one refactor away from leaking a tenant.
  it("scopes the query by profile_id, not by a post-hoc filter", async () => {
    const seen = memberships([row("testco")]);
    const { c, nextFn } = mockContext(asUser());

    await createTenantMembershipMiddleware()(c as any, nextFn as any);

    expect(seen[0]!.sql).toContain("tenant_memberships");
    expect(seen[0]!.sql).toContain("m.profile_id = $1");
    expect(seen[0]!.params).toEqual(["user-123"]);
  });

  // The regression this replaces. `LIMIT 1` on a two-row result answered a
  // question the user never asked.
  it("does NOT silently pick one of several memberships", async () => {
    memberships([row("alpha"), row("beta")]);
    const { c, jsonFn, nextFn } = mockContext(asUser());

    await createTenantMembershipMiddleware()(c as any, nextFn as any);

    expect(jsonFn).toHaveBeenCalledWith(
      expect.objectContaining({
        error: "tenant_required",
        available: expect.arrayContaining([
          expect.objectContaining({ slug: "alpha" }),
          expect.objectContaining({ slug: "beta" }),
        ]),
      }),
      409,
    );
    expect(nextFn).not.toHaveBeenCalled();
  });

  it("selects the requested tenant when several are available", async () => {
    memberships([row("alpha"), row("beta")]);
    const { c, setFn, nextFn } = mockContext({
      ...asUser(),
      tenantHeader: "beta",
    });

    await createTenantMembershipMiddleware()(c as any, nextFn as any);

    expect(setFn).toHaveBeenCalledWith(
      "tenant",
      expect.objectContaining({ tenantSlug: "beta" }),
    );
    expect(nextFn).toHaveBeenCalled();
  });

  it("accepts the selector as a query parameter too", async () => {
    memberships([row("alpha"), row("beta")]);
    const { c, setFn, nextFn } = mockContext({
      ...asUser(),
      tenantQuery: "alpha",
    });

    await createTenantMembershipMiddleware()(c as any, nextFn as any);

    expect(setFn).toHaveBeenCalledWith(
      "tenant",
      expect.objectContaining({ tenantSlug: "alpha" }),
    );
  });

  // T4.5. A membership in A must grant nothing in B.
  it("refuses a tenant the caller has no membership in", async () => {
    memberships([row("alpha")]);
    const { c, jsonFn, nextFn } = mockContext({
      ...asUser(),
      tenantHeader: "someone-elses",
    });

    await createTenantMembershipMiddleware()(c as any, nextFn as any);

    expect(jsonFn).toHaveBeenCalledWith({ error: "tenant_not_found" }, 404);
    expect(nextFn).not.toHaveBeenCalled();
  });

  // Saying 403 here and 404 for a missing slug would turn this endpoint into
  // an oracle for discovering which restaurants exist on the platform.
  it("answers identically for a tenant that does not exist", async () => {
    memberships([row("alpha")]);
    const { c, jsonFn, nextFn } = mockContext({
      ...asUser(),
      tenantHeader: "no-such-tenant",
    });

    await createTenantMembershipMiddleware()(c as any, nextFn as any);

    expect(jsonFn).toHaveBeenCalledWith({ error: "tenant_not_found" }, 404);
    expect(nextFn).not.toHaveBeenCalled();
  });

  it("returns 404 when the caller holds no membership at all", async () => {
    memberships([]);
    const { c, jsonFn, nextFn } = mockContext(asUser());

    await createTenantMembershipMiddleware()(c as any, nextFn as any);

    expect(jsonFn).toHaveBeenCalledWith({ error: "tenant_not_found" }, 404);
    expect(nextFn).not.toHaveBeenCalled();
  });

  it("returns 401 when user context is missing", async () => {
    const { c, jsonFn, nextFn } = mockContext({});

    await createTenantMembershipMiddleware()(c as any, nextFn as any);

    expect(jsonFn).toHaveBeenCalledWith({ error: "unauthenticated" }, 401);
    expect(nextFn).not.toHaveBeenCalled();
    expect(withClient).not.toHaveBeenCalled();
  });

  it("returns 503 on database failure", async () => {
    vi.mocked(withClient).mockRejectedValueOnce(new Error("connection error"));
    const { c, jsonFn, nextFn } = mockContext(asUser());

    await createTenantMembershipMiddleware()(c as any, nextFn as any);

    expect(jsonFn).toHaveBeenCalledWith({ error: "service_unavailable" }, 503);
    expect(nextFn).not.toHaveBeenCalled();
  });

  // The schema name is spliced into SQL downstream; the old resolver
  // validated it and this one must too.
  it("refuses a schema name that fails validation", async () => {
    memberships([{ ...row("testco"), schema_name: "../../etc/passwd" }]);
    const { c, jsonFn, nextFn } = mockContext(asUser());

    await createTenantMembershipMiddleware()(c as any, nextFn as any);

    expect(jsonFn).toHaveBeenCalledWith({ error: "internal_error" }, 500);
    expect(nextFn).not.toHaveBeenCalled();
  });

  // A revoked membership must take effect on the next request, not whenever a
  // cache entry happens to expire.
  it("resolves from Postgres every request, never from a cache read", async () => {
    const seen = memberships([row("testco")]);
    const { c, nextFn } = mockContext(asUser());

    await createTenantMembershipMiddleware()(c as any, nextFn as any);

    // One query, and it is the membership join.
    expect(seen).toHaveLength(1);
    expect(seen[0]!.sql).toContain("FROM public.tenant_memberships m");
  });
});
