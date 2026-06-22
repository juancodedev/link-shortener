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

vi.mock("../../src/cache/tenant", () => ({
  setCachedSchema: vi.fn().mockResolvedValue(undefined),
}));

import { withClient } from "../../src/db/client";
import { provisionTenant } from "../../src/tenants/provision";
import { deprovisionTenant } from "../../src/tenants/deprovision";
import { createTenant, deleteTenant } from "../../src/api/tenants";

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
