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
  setCachedUrl,
  setCachedRegistryEntry,
} from "../../src/cache/shortcode";
import { trackClick } from "../../src/analytics/tracker";
import {
  redirectHandler,
  renderCardNotConfigured,
  renderSubscriptionPaused,
} from "../../src/handlers/redirect";

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

  it("serves from the registry cache without querying the registry", async () => {
    const { sql } = mockDb({ links: [linkRow({ original_url: "https://cached.example" })] });
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

    expect(sql.some((q) => q.includes("short_code_registry"))).toBe(false);
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

  it("returns 410 for an inactive link in the KV fallback", async () => {
    mockDb({ registry: [registryRow()], linksThrows: true });
    vi.mocked(getCachedUrl).mockResolvedValueOnce(
      JSON.stringify({ url: "https://example.com", isActive: false, expiresAt: null, linkId: "link-uuid" }),
    );

    const { c, jsonFn } = mockContext();

    await redirectHandler(c as any);

    expect(jsonFn).toHaveBeenCalledWith({ error: "link_inactive" }, 410);
  });

  it("returns 410 for an expired link in the KV fallback", async () => {
    mockDb({ registry: [registryRow()], linksThrows: true });
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
    mockDb({ registry: [registryRow()], linksThrows: true });
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
    mockDb({ registry: [registryRow()], linksThrows: true });

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
// Fresh link state
//
// The owner flips "Show before redirecting" in the dashboard and scans the
// sticker to check it. The scan must reflect the saved value, not whatever the
// short-URL KV entry held: KV is eventually consistent, so an entry deleted by
// the PATCH can keep being served for a minute, and a scan racing the PATCH can
// write the old value back for a whole TTL. Postgres is the source of truth;
// KV is only the snapshot a scan falls back on when the database is down.
// ---------------------------------------------------------------------------

function cachedBlob(over: Record<string, unknown> = {}) {
  return JSON.stringify({
    url: "https://example.com",
    isActive: true,
    expiresAt: null,
    linkId: "link-uuid",
    ...over,
  });
}

describe("redirectHandler reads link state fresh", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getCachedRegistryEntry).mockResolvedValue(null);
    vi.mocked(trackClick).mockResolvedValue(undefined);
    vi.mocked(renderActionScreen).mockReturnValue(new Response("screen"));
  });

  it("shows the screen on the next scan after it is turned on, even with a warm cache", async () => {
    mockColdPath({ links: [linkRow({ original_url: GOOGLE_URL, is_gated: true })] });
    vi.mocked(getCachedUrl).mockResolvedValue(cachedBlob({ url: GOOGLE_URL, isGated: false }));

    const { c, redirectFn } = mockContext();

    await redirectHandler(c as any, vi.fn() as any);

    expect(renderActionScreen).toHaveBeenCalled();
    expect(redirectFn).not.toHaveBeenCalled();
  });

  it("redirects on the next scan after the screen is turned off, even with a warm cache", async () => {
    mockColdPath({ links: [linkRow({ is_gated: false })] });
    vi.mocked(getCachedUrl).mockResolvedValue(cachedBlob({ isGated: true }));

    const { c, redirectFn } = mockContext();

    await redirectHandler(c as any, vi.fn() as any);

    expect(renderActionScreen).not.toHaveBeenCalled();
    expect(redirectFn).toHaveBeenCalledWith("https://example.com", 302);
  });

  it("follows a new destination on the next scan, even with a warm cache", async () => {
    mockColdPath({ links: [linkRow({ original_url: "https://new.example" })] });
    vi.mocked(getCachedUrl).mockResolvedValue(cachedBlob({ url: "https://old.example" }));

    const { c, redirectFn } = mockContext();

    await redirectHandler(c as any, vi.fn() as any);

    expect(redirectFn).toHaveBeenCalledWith("https://new.example", 302);
  });

  it("refreshes the fallback snapshot with what the database returned", async () => {
    mockColdPath({ links: [linkRow({ is_gated: true })] });
    vi.mocked(getCachedUrl).mockResolvedValue(cachedBlob({ isGated: false }));

    const { c } = mockContext();

    await redirectHandler(c as any, vi.fn() as any);

    expect(setCachedUrl).toHaveBeenCalledWith(
      expect.anything(),
      "acme",
      "abc123",
      expect.stringContaining('"isGated":true'),
    );
  });

  it("falls back to the cached snapshot when the link query fails", async () => {
    mockDb({ registry: [registryRow()], linksThrows: true });
    vi.mocked(getCachedUrl).mockResolvedValue(cachedBlob({ url: GOOGLE_URL, isGated: true }));

    const { c, jsonFn } = mockContext();

    await redirectHandler(c as any, vi.fn() as any);

    expect(renderActionScreen).toHaveBeenCalled();
    expect(jsonFn).not.toHaveBeenCalledWith({ error: "service_unavailable" }, 503);
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

  // A duplicated <style> block once leaked raw CSS into <main>, so diners saw
  // selector text above the message.
  it("renders the paused page as one document with no CSS in the body", () => {
    const html = renderSubscriptionPaused("demo", "Demo Café", "mailto:billing@example.com");

    expect(html.match(/<style>/g)).toHaveLength(1);
    expect(html.match(/<main>/g)).toHaveLength(1);
    const body = html.slice(html.indexOf("<body>"));
    expect(body).not.toContain("font-size:");
    expect(html).toContain("a.reactivate {");
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
    const { res } = await run("past_due", undefined, "owner@example.test");
    const body = await res.text();

    expect(body).toContain('href="mailto:owner@example.test"');
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

  // The regression this existed to catch: BILLING_CONTACT is configured WITH
  // the mailto: scheme, and a validator that only understood a bare address
  // rejected the exact value the project ships. The page then rendered with no
  // link and no error.
  it("accepts an address that already carries the mailto: scheme", async () => {
    const { res } = await run("past_due", undefined, "mailto:owner@example.test");
    const body = await res.text();

    expect(body).toContain('href="mailto:owner@example.test"');
    // And not doubled: "mailto:mailto:".
    expect(body).not.toContain("mailto:mailto:");
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
    const { res } = await run("past_due", undefined, "owner@example.test");
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

// ---------------------------------------------------------------------------
// Card stock on scan (T4)
//
// A manufactured card is ACTIVE and has no destination. Someone scanning it is
// usually the designer, mid-batch, and the correct outcome is a page that says
// so — not a 404, which reads as a broken product and is the reason a batch
// gets abandoned.
// ---------------------------------------------------------------------------

describe("scanning a card that has no destination yet", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    // An earlier describe installs a module-level spy on resolveRegistryEntry
    // and never restores it. clearAllMocks() resets what that spy was told to
    // return, NOT which functions are still spied, so the stale `past_due`
    // answer survives into this block and every scan becomes a 402. Restoring
    // here is what makes these tests independent of the ones above them.
    vi.restoreAllMocks();
    vi.mocked(getCachedRegistryEntry).mockResolvedValue(null);
    vi.mocked(getCachedUrl).mockResolvedValue(null);
    vi.mocked(trackClick).mockResolvedValue(undefined);
  });


  /**
   * Serves a card whose link row carries no original_url.
   *
   * The not-configured branch returns a raw `Response`, so it is observable
   * only through the promise the handler returns — not through `c.json` or
   * `c.redirect`. Reading the wrong one is how a test would end up asserting
   * on undefined and blaming the page.
   */
  async function scanUnconfigured(over: Record<string, unknown> = {}) {
    mockColdPath({ links: [linkRow({ original_url: null, ...over })] });

    const { c, waitUntilFn } = mockContext({});
    const response = (await redirectHandler(c as any)) as Response;
    await Promise.all(waitUntilFn.mock.calls.map((p: any) => p));

    return { response, status: response.status, body: await response.text() };
  }

  it("serves a page, not a 404", async () => {
    const { status } = await scanUnconfigured();

    // 404 here is the bug this whole branch exists to prevent.
    expect(status).toBe(200);
  });

  it("never redirects the customer anywhere", async () => {
    const { response, body } = await scanUnconfigured();

    // A card with no destination has nothing to forward to, so there is no
    // Location header and no script that navigates a customer. The only
    // navigation on this page is the owner's hop to /setup/:code, gated on a
    // Supabase session — covered in its own suite below.
    expect(response.headers.get("Location")).toBeNull();
    expect(body).not.toMatch(/location\.href\s*=/i);
    expect(body).not.toContain("http-equiv=\"refresh\"");
  });

  it("says the card is real and simply not configured", async () => {
    const { body } = await scanUnconfigured();

    expect(body).toContain("Sin configurar");
    // The reassuring half matters as much as the factual half: whoever is
    // holding this card needs to believe the card itself is fine.
    expect(body).toContain("tarjeta real");
  });

  it("never leaks undefined or null into the rendered page", async () => {
    const { body } = await scanUnconfigured();

    // A visible "undefined" or "null" is the tell that a template was filled
    // from a field that does not exist on this branch.
    expect(body).not.toMatch(/>\s*(undefined|null)\s*</);
    expect(body).not.toContain("undefined");
  });

  it("shows the short code so the owner can find the card", async () => {
    const { body } = await scanUnconfigured();

    expect(body).toContain("abc123");
  });

  it("shows client_ref when set, because it is how the card is identified", async () => {
    const { body } = await scanUnconfigured({ client_ref: "MESA-7" });

    expect(body).toContain("MESA-7");
  });

  it("omits the client_ref line's value when the owner has not set one", async () => {
    const { body } = await scanUnconfigured({ client_ref: null });

    // The code is still shown, so the page is never anonymous — it just does
    // not render an empty element.
    expect(body).toContain("abc123");
    expect(body).not.toMatch(/<code>\s*<\/code>/);
  });

  it("escapes a client_ref carrying markup", async () => {
    const { body } = await scanUnconfigured({
      client_ref: '<img src=x onerror=alert(1)>',
    });

    // This page is rendered to whoever scanned the card, including the public.
    expect(body).not.toContain("<img src=x");
    expect(body).toContain("&lt;img");
  });

  it("marks itself noindex, so a half-manufactured card is never indexed", async () => {
    const { body } = await scanUnconfigured();

    expect(body).toContain('name="robots" content="noindex, nofollow"');
  });

  it("sends no-store, so a card cannot be pinned unconfigured by a CDN", async () => {
    const { response } = await scanUnconfigured();

    // The page must not outlive the moment a destination is loaded.
    expect(response.headers.get("Cache-Control")).toContain("no-store");
  });

  it("does not cache the null destination in KV", async () => {
    mockColdPath({ links: [linkRow({ original_url: null })] });
    const { c, waitUntilFn } = mockContext({});

    await redirectHandler(c as any);
    await Promise.all(waitUntilFn.mock.calls.map((p: any) => p));

    // A cached `null` is unreadable by the cache reader and, worse, could be
    // served as a stale destination once one is loaded.
    expect(setCachedUrl).not.toHaveBeenCalled();
  });

  it("still 302s normally once a destination exists", async () => {
    mockColdPath({ links: [linkRow({ original_url: "https://g.page/x" })] });
    const { c, redirectFn } = mockContext({});

    await redirectHandler(c as any);

    expect(redirectFn).toHaveBeenCalledWith("https://g.page/x", 302);
  });

  it("does not show the not-configured page for an INACTIVE card", async () => {
    // Lifecycle wins. An unconfigured card that was also switched off reports
    // the switch, not the missing destination.
    mockColdPath({ links: [linkRow({ original_url: null, is_active: false })] });
    const { c, jsonFn } = mockContext({});

    await redirectHandler(c as any);

    expect(jsonFn).toHaveBeenCalledWith({ error: "link_inactive" }, 410);
  });

  it("does not show the not-configured page for an EXPIRED card", async () => {
    mockColdPath({
      links: [
        linkRow({
          original_url: null,
          expires_at: new Date(Date.now() - 86_400_000).toISOString(),
        }),
      ],
    });
    const { c, jsonFn } = mockContext({});

    await redirectHandler(c as any);

    expect(jsonFn).toHaveBeenCalledWith({ error: "link_expired" }, 410);
  });

  it("still 404s a code that does not exist at all", async () => {
    // Unconfigured and absent are different facts. Collapsing them would tell a
    // stranger that a card exists when none does.
    mockDb({ registry: [], links: [] });
    const { c, jsonFn } = mockContext({});

    await redirectHandler(c as any);

    expect(jsonFn).toHaveBeenCalledWith({ error: "not_found" }, 404);
  });
});

// ---------------------------------------------------------------------------
// Card quick setup hop
//
// The server cannot tell a logged-in owner from a customer: auth is a Supabase
// session in localStorage, and /:code receives no credentials. So the
// unconfigured page carries a tiny script that hands a browser WITH a session
// to /setup/:code. A customer's browser has no such key and must see exactly
// the page it always did.
//
// The script is executed here against a fake window rather than only grepped,
// because what matters is which browsers it navigates, not that it exists.
// ---------------------------------------------------------------------------

describe("unconfigured card hands a logged-in owner to setup", () => {
  function inlineScripts(html: string): string[] {
    return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
  }

  /** Runs the page's inline scripts against a fake storage and location. */
  function runInBrowser(html: string, storage: Record<string, string> | "throws") {
    const replace = vi.fn();
    const localStorage =
      storage === "throws"
        ? undefined
        : {
            get length() {
              return Object.keys(storage).length;
            },
            key: (i: number) => Object.keys(storage)[i] ?? null,
            getItem: (k: string) => storage[k] ?? null,
          };
    const window: Record<string, unknown> = {};
    Object.defineProperty(window, "localStorage", {
      get() {
        if (storage === "throws") throw new Error("SecurityError: storage blocked");
        return localStorage;
      },
    });
    for (const src of inlineScripts(html)) {
      new Function("window", "location", src)(window, { replace });
    }
    return replace;
  }

  const page = (code = "ywaoSiE") =>
    renderCardNotConfigured({ businessName: "Acme", code, clientRef: "MESA-7" });

  it("sends a browser holding a Supabase session to /setup/:code", () => {
    const replace = runInBrowser(page(), {
      "sb-abcdefgh-auth-token": "{}",
    });

    expect(replace).toHaveBeenCalledWith("/setup/ywaoSiE");
  });

  it("leaves an anonymous visitor on the page", () => {
    expect(runInBrowser(page(), {})).not.toHaveBeenCalled();
  });

  it("ignores storage keys that only look similar", () => {
    const replace = runInBrowser(page(), {
      tenant: "acme",
      "sb-auth-token": "{}",
      "xsb-abc-auth-token": "{}",
      "sb-abc-auth-token-code-verifier": "{}",
    });

    expect(replace).not.toHaveBeenCalled();
  });

  it("leaves the visitor on the page when storage is blocked", () => {
    expect(runInBrowser(page(), "throws")).not.toHaveBeenCalled();
  });

  it("encodes the code into the setup path", () => {
    const replace = runInBrowser(page("a b/c"), { "sb-x-auth-token": "{}" });

    expect(replace).toHaveBeenCalledWith("/setup/a%20b%2Fc");
  });

  it("cannot be broken out of the script by the code", () => {
    const html = page("</script><script>alert(1)</script>");

    expect(html).not.toContain("</script><script>alert(1)");
    expect(html).toContain("\\u003c/script>");
  });
});
