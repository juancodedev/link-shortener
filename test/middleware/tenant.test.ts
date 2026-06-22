import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock cache modules
// ---------------------------------------------------------------------------

vi.mock("../../src/cache/tenant", () => ({
  getCachedSchema: vi.fn().mockResolvedValue(null),
  setCachedSchema: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Mock db/client
// ---------------------------------------------------------------------------

vi.mock("../../src/db/client", () => ({
  withClient: vi.fn(),
}));

import { getCachedSchema, setCachedSchema } from "../../src/cache/tenant";
import { withClient } from "../../src/db/client";
import {
  createTenantMiddleware,
  createUserProfileTenantMiddleware,
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

describe("createUserProfileTenantMiddleware", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves tenant from user profile via DB join", async () => {
    vi.mocked(withClient).mockImplementationOnce(async (_env: any, fn: any) => {
      return fn({
        query: vi.fn().mockResolvedValueOnce({
          rows: [
            { id: "tenant-uuid", schema_name: "tenant_c34e", subdomain: "testco", salt: "salt-xyz" },
          ],
        }),
      });
    });

    const { c, setFn, nextFn, waitUntilFn } = mockContext({
      user: { userId: "user-123", email: "user@test.com" },
    });
    const middleware = createUserProfileTenantMiddleware();

    await middleware(c as any, nextFn as any);

    expect(setFn).toHaveBeenCalledWith("tenant", {
      tenantSlug: "testco",
      schemaName: "tenant_c34e",
      tenantId: "tenant-uuid",
      tenantSalt: "salt-xyz",
    });
    expect(waitUntilFn).toHaveBeenCalled();
    expect(nextFn).toHaveBeenCalled();
  });

  it("returns 404 when user has no profile", async () => {
    vi.mocked(withClient).mockImplementationOnce(async (_env: any, fn: any) => {
      return fn({
        query: vi.fn().mockResolvedValueOnce({ rows: [] }),
      });
    });

    const { c, jsonFn, nextFn } = mockContext({
      user: { userId: "user-no-tenant", email: "user@test.com" },
    });
    const middleware = createUserProfileTenantMiddleware();

    await middleware(c as any, nextFn as any);

    expect(jsonFn).toHaveBeenCalledWith({ error: "tenant_not_found" }, 404);
    expect(nextFn).not.toHaveBeenCalled();
  });

  it("returns 401 when user context is missing", async () => {
    const { c, jsonFn, nextFn } = mockContext({}); // No user
    const middleware = createUserProfileTenantMiddleware();

    await middleware(c as any, nextFn as any);

    expect(jsonFn).toHaveBeenCalledWith({ error: "unauthenticated" }, 401);
    expect(nextFn).not.toHaveBeenCalled();
    expect(withClient).not.toHaveBeenCalled();
  });

  it("returns 503 on database failure", async () => {
    vi.mocked(withClient).mockRejectedValueOnce(new Error("connection error"));

    const { c, jsonFn, nextFn } = mockContext({
      user: { userId: "user-123", email: "user@test.com" },
    });
    const middleware = createUserProfileTenantMiddleware();

    await middleware(c as any, nextFn as any);

    expect(jsonFn).toHaveBeenCalledWith(
      { error: "service_unavailable" },
      503,
    );
    expect(nextFn).not.toHaveBeenCalled();
  });
});
