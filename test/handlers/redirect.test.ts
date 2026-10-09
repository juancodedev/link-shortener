import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock db/client
// ---------------------------------------------------------------------------

vi.mock("../../src/db/client", () => ({
  withClient: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock cache/shortcode
//
// The factory must provide every export `src/handlers/redirect.ts` and
// `src/api/links.ts` import. A missing export resolves to undefined, so the
// first call site that reaches it throws and the handler converts the throw into
// a 503 — the whole suite then fails for the wrong reason.
// ---------------------------------------------------------------------------

vi.mock("../../src/cache/shortcode", () => ({
  getCachedUrl: vi.fn().mockResolvedValue(null),
  setCachedUrl: vi.fn().mockResolvedValue(undefined),
  invalidateCachedUrl: vi.fn().mockResolvedValue(undefined),
  getCachedRegistryEntry: vi.fn().mockResolvedValue(null),
  setCachedRegistryEntry: vi.fn().mockResolvedValue(undefined),
  invalidateCachedRegistryEntry: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Mock analytics/tracker
// ---------------------------------------------------------------------------

vi.mock("../../src/analytics/tracker", () => ({
  trackClick: vi.fn(),
}));

import { withClient } from "../../src/db/client";
import {
  getCachedUrl,
  getCachedRegistryEntry,
  setCachedRegistryEntry,
} from "../../src/cache/shortcode";
import { trackClick } from "../../src/analytics/tracker";
import { redirectHandler } from "../../src/handlers/redirect";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockContext(overrides: { code?: string } = {}) {
  const jsonFn = vi.fn().mockImplementation(
    (body: unknown, status: number) => new Response(JSON.stringify(body), { status }),
  );
  const redirectFn = vi.fn().mockImplementation(
    (url: string, status: number) =>
      new Response(null, { status, headers: { Location: url } }),
  );
  const waitUntilFn = vi.fn();
  const paramFn = vi.fn().mockImplementation((name: string) => {
    if (name === "code") return overrides.code ?? "abc123";
    return "";
  });

  const c = {
    req: {
      param: paramFn,
      raw: new Request("https://short.link/abc123"),
    },
    env: {
      SHORT_URL_DOMAIN: "short.link",
      SUPABASE_JWT_SECRET: "test-secret",
      SUPABASE_URL: "https://test.supabase.co",
      SUPABASE_ANON_KEY: "test-anon-key",
      SUPABASE_SERVICE_ROLE_KEY: "test-service-key",
      SHORT_URL_CACHE: {} as any,
      TENANT_CACHE: {} as any,
    },
    json: jsonFn,
    redirect: redirectFn,
    get: vi.fn(),
    executionCtx: {
      waitUntil: waitUntilFn,
    },
  };

  return { c, jsonFn, redirectFn, waitUntilFn };
}

/** A `public.short_code_registry` join row, as the resolver query returns it. */
function registryRow(over: Record<string, unknown> = {}) {
  return {
    short_code: "abc123",
    link_id: "link-uuid",
    tenant_id: "tenant-uuid",
    schema_name: "tenant_a7f3",
    salt: "salt-abc",
    subdomain: "acme",
    ...over,
  };
}

/** A `{tenant}.links` row, as the link fallback query returns it. */
function linkRow(over: Record<string, unknown> = {}) {
  return {
    id: "link-uuid",
    original_url: "https://example.com",
    is_active: true,
    expires_at: null,
    ...over,
  };
}

/**
 * Routes `query()` by SQL shape instead of by call order, so a test states what
 * each statement returns rather than depending on how many round trips the
 * handler happens to make.
 */
function mockDb(opts: {
  registry?: unknown[];
  links?: unknown[];
  registryThrows?: boolean;
  linksThrows?: boolean;
}) {
  const sql: string[] = [];

  vi.mocked(withClient).mockImplementation(async (_env: any, fn: any) =>
    fn({
      query: vi.fn().mockImplementation(async (text: string) => {
        sql.push(text);
        if (text.includes("short_code_registry")) {
          if (opts.registryThrows) throw new Error("registry query failed");
          return { rows: opts.registry ?? [], rowCount: (opts.registry ?? []).length };
        }
        if (text.includes("links")) {
          if (opts.linksThrows) throw new Error("links query failed");
          return { rows: opts.links ?? [], rowCount: (opts.links ?? []).length };
        }
        return { rows: [], rowCount: 0 };
      }),
    }),
  );

  return { sql };
}

/** Registry resolved, short-code KV missed: the common cold path. */
function mockColdPath(opts: { links?: unknown[] } = {}) {
  return mockDb({ registry: [registryRow()], links: opts.links ?? [linkRow()] });
}

// ---------------------------------------------------------------------------
// Registry resolution (T3.1) — the isolation boundary
// ---------------------------------------------------------------------------

describe("redirectHandler registry resolution (T3.1)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getCachedRegistryEntry).mockResolvedValue(null);
    vi.mocked(getCachedUrl).mockResolvedValue(null);
    vi.mocked(trackClick).mockResolvedValue(undefined);
  });

  it("resolves the tenant from public.short_code_registry before reading a link", async () => {
    const { sql } = mockColdPath();

    const { c, redirectFn } = mockContext();

    await redirectHandler(c as any);

    expect(sql[0]).toContain("public.short_code_registry");
    expect(sql[0]).toContain("public.tenants");
    expect(redirectFn).toHaveBeenCalledWith("https://example.com", 302);
  });

  it("selects the link from the RESOLVED tenant schema, not one named in the URL", async () => {
    const { sql } = mockColdPath();

    const { c } = mockContext();

    await redirectHandler(c as any);

    // The URL is only /abc123 — the schema came from the registry join.
    // The qualified identifier is `"<schema>"."links"` — quoted, so match the
    // quoted form rather than a bare `.links`.
    const linkQuery = sql.find((s) => s.includes('"."links"'))!;
    expect(linkQuery).toContain('"tenant_a7f3"."links"');
  });

  it("returns 404 on a registry miss and never opens a tenant schema", async () => {
    const { sql } = mockDb({ registry: [], links: [linkRow()] });

    const { c, jsonFn, redirectFn } = mockContext();

    await redirectHandler(c as any);

    expect(jsonFn).toHaveBeenCalledWith({ error: "not_found" }, 404);
    expect(redirectFn).not.toHaveBeenCalled();

    // The link row was available, but nothing may read it without a tenant.
    expect(sql.some((s) => s.includes('"."links"'))).toBe(false);
    expect(withClient).toHaveBeenCalledTimes(1);
  });

  it("returns 404 when the registry row points at an inactive tenant", async () => {
    // The resolver's WHERE clause filters is_active — modelled as an empty
    // result, which is what the database returns for a deactivated tenant.
    mockDb({ registry: [], links: [] });

    const { c, jsonFn } = mockContext();

    await redirectHandler(c as any);

    expect(jsonFn).toHaveBeenCalledWith({ error: "not_found" }, 404);
  });

  it("returns 503 when the registry query fails", async () => {
    mockDb({ registryThrows: true, links: [] });

    const { c, jsonFn } = mockContext();

    await redirectHandler(c as any);

    expect(jsonFn).toHaveBeenCalledWith({ error: "service_unavailable" }, 503);
  });

  it("refuses to build a query from a registry schema name that is not a safe identifier", async () => {
    // validateSchemaName is the only thing standing between a database value and
    // an interpolated identifier. A poisoned or corrupt row must degrade, not
    // execute: no redirect, and no tenant SQL is issued.
    vi.mocked(getCachedRegistryEntry).mockResolvedValue({
      tenantId: "tenant-uuid",
      schemaName: 'evil"; DROP TABLE links; --',
      tenantSalt: "salt",
      subdomain: "acme",
      linkId: "link-uuid",
    });
    const { sql } = mockDb({ registry: [registryRow()], links: [linkRow()] });

    const { c, jsonFn, redirectFn } = mockContext();

    await redirectHandler(c as any);

    expect(jsonFn).toHaveBeenCalledWith({ error: "service_unavailable" }, 503);
    expect(redirectFn).not.toHaveBeenCalled();
    expect(sql.some((s) => s.includes("evil"))).toBe(false);
  });

  it("warm-caches the registry entry after a database hit", async () => {
    mockColdPath();

    const { c, waitUntilFn } = mockContext();

    await redirectHandler(c as any);

    expect(setCachedRegistryEntry).toHaveBeenCalledWith(
      expect.anything(),
      "abc123",
      expect.objectContaining({ schemaName: "tenant_a7f3", tenantId: "tenant-uuid" }),
    );
    // Registry warm + link KV populate + click tracking
    expect(waitUntilFn.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("serves from the registry cache without touching the database", async () => {
    vi.mocked(getCachedRegistryEntry).mockResolvedValue({
      tenantId: "tenant-uuid",
      schemaName: "tenant_a7f3",
      tenantSalt: "salt-abc",
      subdomain: "acme",
      linkId: "link-uuid",
    });
    vi.mocked(getCachedUrl).mockResolvedValue(
      JSON.stringify({
        url: "https://cached.example",
        isActive: true,
        expiresAt: null,
        linkId: "link-uuid",
      }),
    );

    const { c, redirectFn } = mockContext();

    await redirectHandler(c as any);

    expect(withClient).not.toHaveBeenCalled();
    expect(redirectFn).toHaveBeenCalledWith("https://cached.example", 302);
  });

  it("records the click against the tenant resolved from the registry", async () => {
    mockColdPath();

    const { c, waitUntilFn } = mockContext();

    await redirectHandler(c as any);

    await Promise.all(waitUntilFn.mock.calls.map((p: Promise<unknown>) => p));

    expect(trackClick).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        tenantId: "tenant-uuid",
        schemaName: "tenant_a7f3",
        tenantSalt: "salt-abc",
        linkId: "link-uuid",
        shortCode: "abc123",
      }),
    );
  });

  it("returns 404 when the path segment is empty", async () => {
    const { c, jsonFn } = mockContext({ code: "" });

    await redirectHandler(c as any);

    expect(jsonFn).toHaveBeenCalledWith({ error: "not_found" }, 404);
    expect(withClient).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Link lifecycle (unchanged from the tenant-scoped handler)
// ---------------------------------------------------------------------------

describe("redirectHandler link lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getCachedRegistryEntry).mockResolvedValue(null);
    vi.mocked(getCachedUrl).mockResolvedValue(null);
    vi.mocked(trackClick).mockResolvedValue(undefined);
  });

  it("returns 410 for an inactive link in the KV cache", async () => {
    vi.mocked(getCachedUrl).mockResolvedValueOnce(
      JSON.stringify({ url: "https://example.com", isActive: false, expiresAt: null, linkId: "link-uuid" }),
    );

    const { c, jsonFn } = mockContext();

    await redirectHandler(c as any);

    expect(jsonFn).toHaveBeenCalledWith({ error: "link_inactive" }, 410);
  });

  it("returns 410 for an expired link in the KV cache", async () => {
    vi.mocked(getCachedUrl).mockResolvedValueOnce(
      JSON.stringify({
        url: "https://example.com",
        isActive: true,
        expiresAt: "2020-01-01T00:00:00Z",
        linkId: "link-uuid",
      }),
    );

    const { c, jsonFn } = mockContext();

    await redirectHandler(c as any);

    expect(jsonFn).toHaveBeenCalledWith({ error: "link_expired" }, 410);
  });

  it("returns 410 for an inactive link read from the database", async () => {
    mockColdPath({ links: [linkRow({ is_active: false })] });

    const { c, jsonFn } = mockContext();

    await redirectHandler(c as any);

    expect(jsonFn).toHaveBeenCalledWith({ error: "link_inactive" }, 410);
  });

  it("returns 410 for an expired link read from the database", async () => {
    mockColdPath({ links: [linkRow({ expires_at: "2020-01-01T00:00:00Z" })] });

    const { c, jsonFn } = mockContext();

    await redirectHandler(c as any);

    expect(jsonFn).toHaveBeenCalledWith({ error: "link_expired" }, 410);
  });

  it("returns 404 when the registry resolves but the link is gone", async () => {
    mockDb({ registry: [registryRow()], links: [] });

    const { c, jsonFn } = mockContext();

    await redirectHandler(c as any);

    expect(jsonFn).toHaveBeenCalledWith({ error: "not_found" }, 404);
  });

  it("returns 503 when the link query fails", async () => {
    mockDb({ registry: [registryRow()], linksThrows: true });

    const { c, jsonFn } = mockContext();

    await redirectHandler(c as any);

    expect(jsonFn).toHaveBeenCalledWith({ error: "service_unavailable" }, 503);
  });

  it("handles a legacy plain-URL cache entry (not JSON)", async () => {
    mockDb({ registry: [registryRow()] });
    vi.mocked(getCachedUrl).mockResolvedValueOnce("https://legacy-url.com");

    const { c, redirectFn } = mockContext();

    await redirectHandler(c as any);

    expect(redirectFn).toHaveBeenCalledWith("https://legacy-url.com", 302);
  });
});
