import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock db/client
// ---------------------------------------------------------------------------

vi.mock("../../src/db/client", () => ({
  withClient: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock tenants/provision
// ---------------------------------------------------------------------------

vi.mock("../../src/tenants/provision", () => ({
  provisionTenant: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock tenants/deprovision
// ---------------------------------------------------------------------------

vi.mock("../../src/tenants/deprovision", () => ({
  deprovisionTenant: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock cache/tenant
// ---------------------------------------------------------------------------

//
// The mock must mirror the export `src/api/tenants.ts` actually imports
// (`setCachedTenant` — see src/api/tenants.ts:7). Providing only the legacy
// `setCachedSchema` wrapper leaves the imported binding undefined, so the
// KV warm call throws "No export is defined on the mock" and createTenant
// never reaches its 201 response.
// ---------------------------------------------------------------------------

vi.mock("../../src/cache/tenant", () => ({
  setCachedTenant: vi.fn().mockResolvedValue(undefined),
}));

import { withClient } from "../../src/db/client";
import { provisionTenant } from "../../src/tenants/provision";
import { deprovisionTenant } from "../../src/tenants/deprovision";
import { createTenant, deleteTenant, listTenants } from "../../src/api/tenants";

// ---------------------------------------------------------------------------
// Helper: mock Hono context
// ---------------------------------------------------------------------------

function mockContext(overrides: {
  tenantId?: string;
  body?: object;
  jsonParseError?: boolean;
} = {}) {
  const jsonFn = vi.fn().mockImplementation(
    (body: unknown, status: number) => new Response(JSON.stringify(body), { status }),
  );
  const waitUntilFn = vi.fn();

  const c = {
    req: {
      param: vi.fn().mockReturnValue(overrides.tenantId ?? null),
      json: overrides.jsonParseError
        ? vi.fn().mockRejectedValue(new Error("Invalid JSON"))
        : vi.fn().mockResolvedValue(overrides.body ?? {}),
    },
    env: {
      SHORT_URL_DOMAIN: "short.link",
      SUPABASE_JWT_SECRET: "test-secret",
      SUPABASE_URL: "https://test.supabase.co",
      SUPABASE_ANON_KEY: "test-anon-key",
      SUPABASE_SERVICE_ROLE_KEY: "test-service-key",
    },
    json: jsonFn,
    get: vi.fn().mockImplementation((key: string) => {
      if (key === "user") return { userId: "user-123", email: "user@test.com" };
      return undefined;
    }),
    executionCtx: {
      waitUntil: waitUntilFn,
    },
  };

  return { c, jsonFn, waitUntilFn };
}

// ---------------------------------------------------------------------------
// POST /api/tenants — Provision tests (REQ-T001, REQ-T002)
// ---------------------------------------------------------------------------

describe("createTenant handler (POST)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 201 on successful provisioning", async () => {
    // Uniqueness check: no existing tenant
    vi.mocked(withClient).mockImplementationOnce(async (_env: any, fn: any) => {
      return fn({
        query: vi.fn().mockResolvedValueOnce({
          rows: [{ exists: false }],
        }),
      });
    });

    vi.mocked(provisionTenant).mockResolvedValueOnce({
      schemaName: "tenant_a7f3d2b1",
      tenantId: "new-tenant-uuid",
    });

    const { c, jsonFn } = mockContext({
      body: { subdomain: "acme-corp", display_name: "Acme Corp" },
    });

    await createTenant(c as any);

    expect(jsonFn).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant_id: "new-tenant-uuid",
        subdomain: "acme-corp",
        schema_name: "tenant_a7f3d2b1",
        display_name: "Acme Corp",
      }),
      201,
    );
  });

  it("returns 409 for duplicate subdomain", async () => {
    vi.mocked(withClient).mockImplementationOnce(async (_env: any, fn: any) => {
      return fn({
        query: vi.fn().mockResolvedValueOnce({
          rows: [{ exists: true }],
        }),
      });
    });

    const { c } = mockContext({
      body: { subdomain: "acme-corp", display_name: "Acme Corp" },
    });

    await expect(createTenant(c as any)).rejects.toThrow("already taken");
  });

  it("throws on invalid slug", async () => {
    const { c } = mockContext({
      body: { subdomain: "ab", display_name: "Too Short" },
    });

    await expect(createTenant(c as any)).rejects.toThrow();
  });

  it("rejects reserved words", async () => {
    const { c } = mockContext({
      body: { subdomain: "admin", display_name: "Admin Slug" },
    });

    await expect(createTenant(c as any)).rejects.toThrow("reserved");
  });

  it("uses display_name as fallback when not provided", async () => {
    vi.mocked(withClient).mockImplementationOnce(async (_env: any, fn: any) => {
      return fn({
        query: vi.fn().mockResolvedValueOnce({
          rows: [{ exists: false }],
        }),
      });
    });

    vi.mocked(provisionTenant).mockResolvedValueOnce({
      schemaName: "tenant_b12dc",
      tenantId: "tenant-uuid-2",
    });

    const { c, jsonFn } = mockContext({
      body: { subdomain: "testco" },
    });

    await createTenant(c as any);

    expect(jsonFn).toHaveBeenCalledWith(
      expect.objectContaining({
        subdomain: "testco",
        display_name: "testco",
      }),
      201,
    );
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/tenants/:id — Deprovision tests (REQ-T003)
// ---------------------------------------------------------------------------

describe("deleteTenant handler (DELETE)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 204 on successful deletion", async () => {
    vi.mocked(withClient).mockImplementationOnce(async (_env: any, fn: any) => {
      return fn({
        query: vi.fn().mockResolvedValueOnce({
          rows: [
            {
              id: "tenant-uuid",
              schema_name: "tenant_a7f3",
              subdomain: "acme",
              owner_id: "user-123",
            },
          ],
        }),
      });
    });

    vi.mocked(deprovisionTenant).mockResolvedValueOnce(undefined);

    const { c } = mockContext({ tenantId: "tenant-uuid" });

    const response = await deleteTenant(c as any);

    expect(response.status).toBe(204);
  });

  it("returns 403 when user is not the tenant owner", async () => {
    vi.mocked(withClient).mockImplementationOnce(async (_env: any, fn: any) => {
      return fn({
        query: vi.fn().mockResolvedValueOnce({
          rows: [
            {
              id: "tenant-uuid",
              schema_name: "tenant_a7f3",
              subdomain: "acme",
              owner_id: "other-user",
            },
          ],
        }),
      });
    });

    const { c } = mockContext({ tenantId: "tenant-uuid" });

    await expect(deleteTenant(c as any)).rejects.toThrow("not the owner");
  });

  it("returns 404 when tenant is not found", async () => {
    vi.mocked(withClient).mockImplementationOnce(async (_env: any, fn: any) => {
      return fn({
        query: vi.fn().mockResolvedValueOnce({ rows: [] }),
      });
    });

    const { c } = mockContext({ tenantId: "nonexistent" });

    await expect(deleteTenant(c as any)).rejects.toThrow("not found");
  });
});

// ---------------------------------------------------------------------------
// GET /api/tenants — the switcher's data source
// ---------------------------------------------------------------------------

describe("listTenants", () => {
  const env = {
    SUPABASE_URL: "https://test.supabase.co",
    SUPABASE_ANON_KEY: "k",
    SUPABASE_SERVICE_ROLE_KEY: "s",
    SUPABASE_JWT_SECRET: "j",
    SHORT_URL_DOMAIN: "short.link",
  } as any;

  function ctx(over: { user?: unknown } = {}) {
    const jsonFn = vi.fn().mockImplementation(
      (b: unknown, s?: number) =>
        new Response(JSON.stringify(b), { status: s ?? 200 }),
    );
    return {
      c: {
        env,
        get: vi.fn((k: string) => (k === "user" ? over.user : undefined)),
        json: jsonFn,
      } as any,
      jsonFn,
    };
  }

  function membershipRows(rows: unknown[]) {
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

  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns every tenant the caller can reach", async () => {
    membershipRows([
      { slug: "alpha", schema_name: "tenant_alpha", display_name: "Alpha", role: "owner" },
      { slug: "beta", schema_name: "tenant_beta", display_name: null, role: "viewer" },
    ]);
    const { c, jsonFn } = ctx({ user: { userId: "u1", email: "a@b.c" } });

    await listTenants(c, vi.fn() as any);

    const [body] = jsonFn.mock.calls[0];
    expect(body).toEqual({
      tenants: [
        { slug: "alpha", schemaName: "tenant_alpha", displayName: "Alpha", role: "owner" },
        // Falls back to the slug rather than rendering a blank row in the switcher.
        { slug: "beta", schemaName: "tenant_beta", displayName: "beta", role: "viewer" },
      ],
    });
  });

  // T4.5 at the listing level: unreachable tenants are never loaded, so there is
  // no step where they could be loaded and then forgotten.
  it("scopes by profile_id and excludes inactive tenants in the query", async () => {
    const seen = membershipRows([]);
    const { c } = ctx({ user: { userId: "u1", email: "a@b.c" } });

    await listTenants(c, vi.fn() as any);

    expect(seen[0]!.sql).toContain("m.profile_id = $1");
    expect(seen[0]!.sql).toContain("t.is_active = true");
    expect(seen[0]!.params).toEqual(["u1"]);
  });

  it("returns an empty list rather than an error when there are none", async () => {
    membershipRows([]);
    const { c, jsonFn } = ctx({ user: { userId: "u1", email: "a@b.c" } });

    await listTenants(c, vi.fn() as any);

    expect(jsonFn).toHaveBeenCalledWith({ tenants: [] });
  });

  it("returns 401 without a user", async () => {
    const { c, jsonFn } = ctx({});

    await listTenants(c, vi.fn() as any);

    expect(jsonFn).toHaveBeenCalledWith({ error: "unauthenticated" }, 401);
    expect(withClient).not.toHaveBeenCalled();
  });

  it("returns 503 when the database is unavailable", async () => {
    vi.mocked(withClient).mockRejectedValueOnce(new Error("down"));
    const { c, jsonFn } = ctx({ user: { userId: "u1", email: "a@b.c" } });

    await listTenants(c, vi.fn() as any);

    expect(jsonFn).toHaveBeenCalledWith({ error: "service_unavailable" }, 503);
  });
});
