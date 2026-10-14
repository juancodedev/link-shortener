import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock db/client
// ---------------------------------------------------------------------------

vi.mock("../../src/db/client", () => ({
  withClient: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock cache/tenant
// ---------------------------------------------------------------------------

vi.mock("../../src/cache/tenant", () => ({
  invalidateCachedSchema: vi.fn().mockResolvedValue(undefined),
}));

import { withClient } from "../../src/db/client";
import { invalidateCachedSchema } from "../../src/cache/tenant";
import { deprovisionTenant } from "../../src/tenants/deprovision";

// ---------------------------------------------------------------------------
// Tenant deprovisioning tests (REQ-T003)
// ---------------------------------------------------------------------------

describe("deprovisionTenant", () => {
  const env = {
    SUPABASE_URL: "https://test.supabase.co",
    SUPABASE_ANON_KEY: "test-anon-key",
    SUPABASE_JWT_SECRET: "test-secret",
    SUPABASE_SERVICE_ROLE_KEY: "test-service-key",
    SHORT_URL_DOMAIN: "short.link",
  } as any;

  const params = {
    tenantId: "tenant-123",
    schemaName: "tenant_a7f3d2b1",
    subdomain: "acme",
    ownerUserId: "user-456",
  };

  beforeEach(() => {
    vi.resetAllMocks();
    // Ensure invalidateCachedSchema mock always returns a Promise (not undefined)
    // because the source code calls .catch() on its return value.
    vi.mocked(invalidateCachedSchema).mockResolvedValue(undefined);
  });

  function mockCtx() {
    const waitUntilCalls: Promise<unknown>[] = [];
    return {
      waitUntilCalls,
      ctx: {
        waitUntil(promise: Promise<unknown>) {
          waitUntilCalls.push(promise);
        },
      },
    };
  }

  it("drops schema CASCADE, cleans analytics, profiles, and tenants", async () => {
    const executedQueries: string[] = [];

    vi.mocked(withClient).mockImplementation(async (_env: any, fn: any) => {
      return fn({
        query: vi.fn().mockImplementation((sql: string) => {
          executedQueries.push(sql);
          return Promise.resolve({ rows: [] });
        }),
      });
    });

    // Mock global fetch for Auth API
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
    } as Response);

    const { ctx, waitUntilCalls } = mockCtx();

    await deprovisionTenant(
      env,
      params.tenantId,
      params.schemaName,
      params.subdomain,
      params.ownerUserId,
      ctx,
    );

    // Verify DB operations in order
    expect(executedQueries[0]).toContain("DROP SCHEMA");
    expect(executedQueries[0]).toContain("CASCADE");
    expect(executedQueries[1]).toContain("DELETE FROM analytics.link_clicks");
    expect(executedQueries[2]).toContain("DELETE FROM public.profiles p");
    expect(executedQueries[3]).toContain("DELETE FROM public.tenants");

    // Verify side effects are queued via waitUntil
    expect(waitUntilCalls.length).toBeGreaterThanOrEqual(1);

    globalThis.fetch = originalFetch;
  });

  it("invalidates KV cache via waitUntil", async () => {
    vi.mocked(withClient).mockImplementation(async (_env: any, fn: any) => {
      return fn({
        query: vi.fn().mockResolvedValue({ rows: [] }),
      });
    });

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
    } as Response);

    const { ctx, waitUntilCalls } = mockCtx();

    await deprovisionTenant(
      env,
      params.tenantId,
      params.schemaName,
      params.subdomain,
      params.ownerUserId,
      ctx,
    );

    // Wait for waitUntil promises
    await Promise.all(waitUntilCalls);

    // invalidateCachedSchema should have been called with the subdomain
    expect(invalidateCachedSchema).toHaveBeenCalledWith(env, "acme");

    globalThis.fetch = undefined as any;
  });

  it("handles KV failure as non-fatal (does not throw)", async () => {
    vi.mocked(withClient).mockImplementation(async (_env: any, fn: any) => {
      return fn({
        query: vi.fn().mockResolvedValue({ rows: [] }),
      });
    });

    vi.mocked(invalidateCachedSchema).mockRejectedValueOnce(
      new Error("KV unreachable"),
    );

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
    } as Response);

    const { ctx, waitUntilCalls } = mockCtx();

    // Should NOT throw even though KV fails
    await expect(
      deprovisionTenant(
        env,
        params.tenantId,
        params.schemaName,
        params.subdomain,
        params.ownerUserId,
        ctx,
      ),
    ).resolves.toBeUndefined();

    // DB cleanup should still have completed
    expect(withClient).toHaveBeenCalled();

    globalThis.fetch = undefined as any;
  });

  it("handles Auth API failure as non-fatal", async () => {
    vi.mocked(withClient).mockImplementation(async (_env: any, fn: any) => {
      return fn({
        query: vi.fn().mockResolvedValue({ rows: [] }),
      });
    });

    // Auth API returns 500
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    } as Response);

    const { ctx, waitUntilCalls } = mockCtx();

    await expect(
      deprovisionTenant(
        env,
        params.tenantId,
        params.schemaName,
        params.subdomain,
        params.ownerUserId,
        ctx,
      ),
    ).resolves.toBeUndefined();

    // DB operations should still have completed
    expect(withClient).toHaveBeenCalled();

    globalThis.fetch = undefined as any;
  });

  it("deletes the Supabase Auth user via Admin API", async () => {
    vi.mocked(withClient).mockImplementation(async (_env: any, fn: any) => {
      return fn({
        query: vi.fn().mockResolvedValue({ rows: [] }),
      });
    });

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
    } as Response);
    globalThis.fetch = fetchMock;

    const { ctx, waitUntilCalls } = mockCtx();

    await deprovisionTenant(
      env,
      params.tenantId,
      params.schemaName,
      params.subdomain,
      params.ownerUserId,
      ctx,
    );

    // Wait for waitUntil
    await Promise.all(waitUntilCalls);

    // fetch should have been called with the Auth Admin delete URL
    const fetchCalls = fetchMock.mock.calls;
    const authCall = fetchCalls.find((call: string[]) =>
      call[0]?.includes("/auth/v1/admin/users/"),
    );
    expect(authCall).toBeDefined();
    expect(authCall![0]).toContain("user-456");
    expect(authCall![1]).toMatchObject({
      method: "DELETE",
      headers: expect.objectContaining({
        Authorization: expect.stringContaining("Bearer"),
      }),
    });

    globalThis.fetch = undefined as any;
  });
});

// ---------------------------------------------------------------------------
// Multi-site RBAC: removing one store must not remove a person
// ---------------------------------------------------------------------------

describe("deprovisionTenant — multi-tenant safety", () => {
  const env = {
    SUPABASE_URL: "https://test.supabase.co",
    SUPABASE_ANON_KEY: "test-anon-key",
    SUPABASE_JWT_SECRET: "test-secret",
    SUPABASE_SERVICE_ROLE_KEY: "test-service-key",
    SHORT_URL_DOMAIN: "short.link",
  } as any;

  /** Captures statements; `rows` controls what the profile DELETE returns. */
  function capture(rows: unknown[] = [], membershipsLeft = 0) {
    const queries: string[] = [];
    vi.mocked(withClient).mockImplementation(async (_env: any, fn: any) =>
      fn({
        query: vi.fn().mockImplementation((sql: string) => {
          queries.push(sql);
          if (sql.includes("DELETE FROM public.profiles p")) {
            return Promise.resolve({ rows });
          }
          if (sql.includes("FROM public.tenant_memberships m")) {
            return Promise.resolve({ rows: [{ n: membershipsLeft }] });
          }
          return Promise.resolve({ rows: [] });
        }),
      }),
    );
    return queries;
  }

  // Fire-and-forget work is queued, not awaited, so the tests must drain it to
  // observe anything the handler deferred. Draining also returns the promise,
  // which the handler chains `.catch()` onto.
  const queued: Promise<unknown>[] = [];
  const ctx = {
    waitUntil(p: Promise<unknown>) {
      queued.push(p);
      return p;
    },
  } as any;

  let fetchSpy: ReturnType<typeof vi.fn>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    vi.resetAllMocks();
    originalFetch = globalThis.fetch;
    // The real handler calls the Supabase Admin API. Stub it so the suite never
    // makes a network call, and so the tests can assert on whether it was
    // called at all — which is the whole point of the last two tests here.
    fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    globalThis.fetch = fetchSpy as any;
    // resetAllMocks clears the module-level mockResolvedValue, and
    // deprovision chains .catch() onto this call's result. Without restoring it
    // the return is undefined and every test dies on the mock, not the code.
    vi.mocked(invalidateCachedSchema).mockResolvedValue(undefined);
  });

  // The bug this change prevents. profiles.id references auth.users ON DELETE
  // CASCADE, so deleting a profile destroys the login. A person in a chain has
  // ONE profile and N memberships; removing them from one store must delete
  // that store's membership only.
  it("never deletes a profile that still has memberships elsewhere", async () => {
    const queries = capture([]);

    await deprovisionTenant(env, "tenant-1", "tenant_ab12", "mesa", "owner-1", ctx);

    const profileDelete = queries.find((q) => q.includes("DELETE FROM public.profiles p"))!;
    expect(profileDelete).toBeDefined();
    // The guard is the whole point: only profiles with nothing left anywhere.
    expect(profileDelete).toContain("NOT EXISTS");
    expect(profileDelete).toContain("tenant_memberships");
  });

  it("still cleans up a profile left with no memberships at all", async () => {
    const queries = capture([{ id: "user-1" }]);

    await deprovisionTenant(env, "tenant-1", "tenant_ab12", "mesa", "owner-1", ctx);

    expect(queries.some((q) => q.includes("DELETE FROM public.profiles p"))).toBe(true);
  });

  // The membership row goes with the tenant through its own CASCADE; this test
  // exists so that is a stated intent rather than an accident.
  it("relies on tenant cascade for the membership row, not a manual delete", async () => {
    const queries = capture([]);

    await deprovisionTenant(env, "tenant-1", "tenant_ab12", "mesa", "owner-1", ctx);

    expect(
      queries.some((q) => q.includes("DELETE FROM public.tenant_memberships")),
    ).toBe(false);
    expect(queries.some((q) => q.includes("DELETE FROM public.tenants"))).toBe(true);
  });

  // The second half of the same bug. profiles.id references auth.users ON
  // DELETE CASCADE, and this call destroys the login outright — so removing
  // one store from a chain would lock the owner out of every other store.
  it("does NOT delete the Supabase login while other memberships remain", async () => {
    capture([], 12); // 12 other active stores

    await deprovisionTenant(env, "tenant-1", "tenant_ab12", "mesa", "owner-1", ctx);
    await Promise.allSettled(queued);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does delete the login when the last membership is gone", async () => {
    capture([], 0); // no other active stores

    await deprovisionTenant(env, "tenant-1", "tenant_ab12", "mesa", "owner-1", ctx);
    await Promise.allSettled(queued);

    expect(fetchSpy).toHaveBeenCalled();
    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain("/auth/v1/admin/users/");
  });
});
