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

// ---------------------------------------------------------------------------
// Phase 2 — the dual-path action screen (T2.4)
//
// A gated link renders the screen instead of a 302. Both options are always
// visible and the destination URL is never withheld: this is the compliance
// guarantee, and the tests below are what stop someone re-adding a branch.
// ---------------------------------------------------------------------------

vi.mock("../../src/handlers/action-screen", () => ({
  renderActionScreen: vi.fn(),
}));

import { renderActionScreen } from "../../src/handlers/action-screen";

const GOOGLE_URL = "https://search.google.com/local/writereview?placeid=abc";

function mockGated(opts: { links?: unknown[]; cachedUrl?: string | null } = {}) {
  const path = mockColdPath({
    links: opts.links ?? [linkRow({ original_url: GOOGLE_URL, is_gated: true })],
  });
  vi.mocked(getCachedUrl).mockResolvedValue(
    opts.cachedUrl === undefined ? null : opts.cachedUrl,
  );
  return path;
}

describe("redirectHandler action screen (T2.4)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(renderActionScreen).mockReturnValue(
      new Response("<html>screen</html>", {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      }),
    );
  });

  it("renders the screen instead of redirecting when the link is gated", async () => {
    mockGated();

    const { c, redirectFn } = mockContext();

    await redirectHandler(c as any, vi.fn() as any);

    expect(renderActionScreen).toHaveBeenCalled();
    expect(redirectFn).not.toHaveBeenCalled();
  });

  it("still 302s when the link is not gated", async () => {
    mockColdPath({ links: [linkRow({ is_gated: false })] });

    const { c, redirectFn } = mockContext();

    await redirectHandler(c as any, vi.fn() as any);

    expect(renderActionScreen).not.toHaveBeenCalled();
    expect(redirectFn).toHaveBeenCalledWith("https://example.com", 302);
  });

  it("still 302s when an older cache blob carries no is_gated field", async () => {
    // KV entries survive a deploy for up to 24h. A blob written before this
    // change has no is_gated key at all, and treating that as "gated" would
    // replace every live redirect with an interstitial on deploy day.
    const legacy = JSON.stringify({
      url: "https://example.com",
      isActive: true,
      expiresAt: null,
      linkId: "link-uuid",
    });
    mockGated({ cachedUrl: legacy });

    const { c, redirectFn } = mockContext();

    await redirectHandler(c as any, vi.fn() as any);

    expect(renderActionScreen).not.toHaveBeenCalled();
    expect(redirectFn).toHaveBeenCalledWith("https://example.com", 302);
  });

  it("hands the screen the destination URL and the tenant name", async () => {
    mockDb({
      registry: [registryRow({ display_name: "Sabores" })],
      links: [linkRow({ original_url: GOOGLE_URL, is_gated: true })],
    });
    vi.mocked(getCachedUrl).mockResolvedValue(null);

    const { c } = mockContext();

    await redirectHandler(c as any, vi.fn() as any);

    const args = vi.mocked(renderActionScreen).mock.calls[0]![0] as any;
    expect(args.destinationUrl).toBe(GOOGLE_URL);
    expect(args.businessName).toBe("Sabores");
  });

  it("falls back to a trailing business name when the cache predates display_name", async () => {
    // Same 24h KV survival problem as is_gated. A registry entry written
    // before display_name existed has no such key; the screen still needs a
    // heading, so the tenant subdomain is the honest fallback.
    vi.mocked(getCachedRegistryEntry).mockResolvedValue({
      tenantId: "tenant-uuid",
      schemaName: "tenant_a7f3",
      tenantSalt: "salt-abc",
      subdomain: "sabores",
      linkId: "link-uuid",
    } as any);
    mockDb({ links: [linkRow({ original_url: GOOGLE_URL, is_gated: true })] });

    const { c } = mockContext();

    await redirectHandler(c as any, vi.fn() as any);

    const args = vi.mocked(renderActionScreen).mock.calls[0]![0] as any;
    expect(args.businessName).toBe("sabores");
  });

  it("still records the click when the screen is served", async () => {
    mockGated();

    const { c, waitUntilFn } = mockContext();

    await redirectHandler(c as any, vi.fn() as any);

    // The scan happened regardless of what the customer does next.
    expect(waitUntilFn).toHaveBeenCalled();
    expect(trackClick).toHaveBeenCalled();
  });

  it("falls back to the plain 302 when rendering the screen throws", async () => {
    // The always-functional contract: a bug in the new UI must never take
    // down a sticker already printed and sitting on a customer's table.
    mockGated();
    vi.mocked(renderActionScreen).mockImplementation(() => {
      throw new Error("screen exploded");
    });

    const { c, redirectFn } = mockContext();

    await redirectHandler(c as any, vi.fn() as any);

    expect(redirectFn).toHaveBeenCalledWith(GOOGLE_URL, 302);
  });

  it("returns the screen with a 200 and an HTML content type", async () => {
    mockGated();

    const { c } = mockContext();

    const res = (await redirectHandler(c as any, vi.fn() as any)) as Response;

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toMatch(/text\/html/i);
  });
});

// ---------------------------------------------------------------------------
// Subscription pause
//
// is_active = false  → 404, the business was removed (existing behaviour)
// subscription_status → 402, the business exists and has not paid
//
// Conflating the two tells a customer their business was deleted when the
// truth is an invoice. That distinction is what these tests hold.
// ---------------------------------------------------------------------------

vi.mock("../../src/handlers/action-screen", () => ({
  renderActionScreen: vi.fn(),
  // redirect.ts imports escapeHtml from here too; without it the module mock
  // hands the handler an undefined binding and the pause page throws.
  escapeHtml: (raw: string) =>
    raw.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"),
}));

describe("subscription pause", () => {
  /** Runs the handler with a registry entry whose status is `status`. */
  async function run(status: string | undefined, cachedUrl?: string, billingContact?: string) {
    vi.resetAllMocks();
    vi.mocked(renderActionScreen).mockReturnValue(new Response("screen"));
    // resetAllMocks clears this module-level mockResolvedValue, and the handler
    // chains .catch() onto trackClick's result. Without restoring it every test
    // dies on the mock rather than on the code.
    const { trackClick: tc } = await import("../../src/analytics/tracker");
    vi.mocked(tc).mockResolvedValue(undefined);

    const { withClient: wc } = await import("../../src/db/client");
    vi.mocked(wc).mockImplementation(async (_e: any, fn: any) =>
      fn({
        query: vi
          .fn()
          .mockResolvedValue({
            // is_active and expires_at are read from this row; a link with an
            // undefined is_active reads as inactive and the handler returns 410,
            // which is the correct answer for the fixture and the wrong one for
            // the test.
            rows: [{ original_url: GOOGLE_URL, is_active: true, expires_at: null, is_gated: false }],
          }),
      }),
    );
    const { getCachedUrl } = await import("../../src/cache/shortcode");
    vi.mocked(getCachedUrl).mockResolvedValue(cachedUrl ?? null);

    const jsonFn = vi.fn().mockImplementation(
      (b: unknown, s: number) => new Response(JSON.stringify(b), { status: s }),
    );
    const redirectFn = vi.fn(
      (url: string, status: number) =>
        new Response(null, { status, headers: { Location: url } }),
    );
    const c = {
      req: {
        param: vi.fn().mockReturnValue("abc123"),
        raw: new Request("https://short.link/abc123"),
      },
      env: {
        SHORT_URL_DOMAIN: "short.link",
        SHORT_URL_CACHE: {} as any,
        ...(billingContact === undefined ? {} : { BILLING_CONTACT: billingContact }),
      },
      json: jsonFn,
      redirect: redirectFn,
      get: vi.fn(),
      executionCtx: { waitUntil: vi.fn() },
      var: {},
    } as any;

    // The registry entry is what the handler reads; stub it at the source.
    const links = await import("../../src/api/links");
    vi.spyOn(links, "resolveRegistryEntry").mockResolvedValue({
      tenantId: "t1",
      schemaName: "tenant_ab",
      tenantSalt: "s1",
      subdomain: "mesa",
      linkId: "l1",
      displayName: "Mesa Dorada",
      ...(status === undefined ? {} : { subscriptionStatus: status }),
    } as any);

    const res = (await redirectHandler(c, vi.fn() as any)) as Response;
    return { res, jsonFn, redirectFn };
  }

  it("redirects normally when the subscription is active", async () => {
    const { res, redirectFn } = await run("active");

    expect(res.status).toBe(302);
    expect(redirectFn).toHaveBeenCalled();
  });

  it("pauses a past_due tenant with 402, not 404", async () => {
    const { res, redirectFn } = await run("past_due");

    // 404 is what a REMOVED business returns. An unpaid invoice must not be
    // reported as a deletion.
    expect(res.status).toBe(402);
    expect(redirectFn).not.toHaveBeenCalled();
  });

  it("pauses a canceled tenant the same way", async () => {
    const { res } = await run("canceled");

    expect(res.status).toBe(402);
  });

  // The critical one. A printed sticker hits a warm cache almost every time,
  // and the Google URL lives in that cache — not in the registry entry. Gating
  // after the cache lookup would let a warm cache serve a paused tenant.
  it("pauses even when the short-URL cache is warm", async () => {
    const warm = JSON.stringify({ url: GOOGLE_URL, isActive: true, linkId: "l1" });
    const { res, redirectFn } = await run("past_due", warm);

    expect(res.status).toBe(402);
    expect(redirectFn).not.toHaveBeenCalled();
  });

  // A registry entry written before the field existed has no such key. Failing
  // closed there would 404 a live business over an absent JSON property.
  it("treats a missing status as active", async () => {
    const { res, redirectFn } = await run(undefined);

    expect(res.status).toBe(302);
    expect(redirectFn).toHaveBeenCalled();
  });

  it("does not cache the pause page anywhere in between", async () => {
    const { res } = await run("past_due");

    expect(res.headers.get("Cache-Control")).toContain("no-store");
    expect(res.headers.get("Content-Type")).toContain("text/html");
  });

  // The diner at the table did nothing wrong. Most often this is an invoice the
  // owner has not seen.
  it("does not accuse the customer or imply the business is closed", async () => {
    const { res } = await run("past_due");
    const body = (await res.text()).toLowerCase();

    expect(body).toContain("pausado");
    expect(body).toContain("abierto");
    for (const blame of ["impago", "deuda", "moroso", "cerrado", "suspendido"]) {
      expect(body).not.toContain(blame);
    }
  });

  it("escapes a business name that contains markup", async () => {
    vi.resetAllMocks();
    vi.mocked(renderActionScreen).mockReturnValue(new Response("screen"));
    const { trackClick: tc } = await import("../../src/analytics/tracker");
    vi.mocked(tc).mockResolvedValue(undefined);
    const { withClient: wc } = await import("../../src/db/client");
    vi.mocked(wc).mockImplementation(async (_e: any, fn: any) =>
      fn({ query: vi.fn().mockResolvedValue({ rows: [] }) }),
    );
    const { getCachedUrl } = await import("../../src/cache/shortcode");
    vi.mocked(getCachedUrl).mockResolvedValue(null);

    const c = {
      req: {
        param: vi.fn().mockReturnValue("abc123"),
        raw: new Request("https://short.link/abc123"),
      },
      env: { SHORT_URL_DOMAIN: "short.link", SHORT_URL_CACHE: {} as any },
      json: vi.fn(),
      redirect: vi.fn(),
      get: vi.fn(),
      executionCtx: { waitUntil: vi.fn() },
      var: {},
    } as any;

    const links = await import("../../src/api/links");
    vi.spyOn(links, "resolveRegistryEntry").mockResolvedValue({
      tenantId: "t1",
      schemaName: "tenant_ab",
      tenantSalt: "s1",
      subdomain: "mesa",
      linkId: "l1",
      displayName: "<script>alert(1)</script>",
      subscriptionStatus: "past_due",
    } as any);

    const res = (await redirectHandler(c, vi.fn() as any)) as Response;
    const body = await res.text();

    expect(body).not.toContain("<script>");
    expect(body).toContain("&lt;script&gt;");
  });
// ---------------------------------------------------------------------------
// Getting out of a pause
//
// Billing is off-platform, so there is no checkout to send the owner to — and a
// button that changed the subscription would defeat the reason /api/ops refuses
// every customer credential. The link must route to a human.
// ---------------------------------------------------------------------------

describe("pause page — reactivation path", () => {
  it("links to the configured contact when there is one", async () => {
    const { res } = await run("past_due", undefined, "hola@juancode.dev");
    const body = await res.text();

    expect(body).toContain('href="mailto:hola@juancode.dev"');
    expect(body).toContain("Reactivar este punto");
  });

  // Operator config, but it lands in an href. A javascript: URL there is script
  // execution on a page a customer is already looking at.
  it("refuses a javascript: contact instead of rendering it", async () => {
    const { res } = await run("past_due", undefined, "javascript:alert(1)");
    const body = await res.text();

    expect(body).not.toContain("javascript:");
    expect(body).not.toContain("<a class=\"reactivate\"");
  });

  it("accepts an https url", async () => {
    const { res } = await run("past_due", undefined, "https://juancode.dev/ayuda");
    expect(await res.text()).toContain('href="https://juancode.dev/ayuda"');
  });

  // A deployment with no support address must still render a usable page — the
  // instructions minus the link, not a broken empty mailto:.
  it("still renders without a contact configured", async () => {
    const { res } = await run("past_due");
    const body = await res.text();

    expect(res.status).toBe(402);
    expect(body).toContain("contactanos para reactivarlo");
    expect(body).not.toContain("mailto:");
  });

  // The diner must not be told they owe something. The reactivation path is
  // separated and addressed to the owner, because they are the one who finds
  // this page by checking their own sticker.
  it("addresses reactivation to the owner, not the diner", async () => {
    const { res } = await run("past_due", undefined, "hola@juancode.dev");
    const body = (await res.text()).toLowerCase();

    // The page uses HTML entities for the accented characters, so the raw body
    // carries `&ntilde;` where a browser would render ñ.
    expect(body).toContain("due&ntilde;o de este negocio");
    expect(body).toContain("el local está abierto");
    for (const blame of ["debate", "impago", "moroso", "adeuda"]) {
      expect(body).not.toContain(blame);
    }
  });
});
});
