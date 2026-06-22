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
    expect(executedQueries[2]).toContain("DELETE FROM public.profiles");
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
