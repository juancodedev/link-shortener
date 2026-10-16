import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock db/client
// ---------------------------------------------------------------------------

vi.mock("../../src/db/client", () => ({
  withClient: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock cache modules
// ---------------------------------------------------------------------------

// Every export src/api/links.ts imports. A missing one resolves to undefined,
// so the first call site that reaches it throws a TypeError that has nothing to
// do with what the test is about.
vi.mock("../../src/cache/shortcode", () => ({
  setCachedUrl: vi.fn().mockResolvedValue(undefined),
  invalidateCachedUrl: vi.fn().mockResolvedValue(undefined),
  getCachedUrl: vi.fn().mockResolvedValue(null),
  getCachedRegistryEntry: vi.fn().mockResolvedValue(null),
  setCachedRegistryEntry: vi.fn().mockResolvedValue(undefined),
  invalidateCachedRegistryEntry: vi.fn().mockResolvedValue(undefined),
}));

/**
 * Re-applies the cache mock implementations after `vi.resetAllMocks()`.
 *
 * resetAllMocks strips implementations, not just recorded calls, so every
 * `beforeEach` that resets has to put them back — otherwise the handler calls
 * `.catch()` on undefined and fails for reasons unrelated to the assertion.
 */
function mockCacheDefaults() {
  vi.mocked(setCachedUrl).mockResolvedValue(undefined);
  vi.mocked(invalidateCachedUrl).mockResolvedValue(undefined);
  vi.mocked(getCachedRegistryEntry).mockResolvedValue(null);
  vi.mocked(setCachedRegistryEntry).mockResolvedValue(undefined);
  vi.mocked(invalidateCachedRegistryEntry).mockResolvedValue(undefined);
}

// ---------------------------------------------------------------------------
// Mock short-code generator
// ---------------------------------------------------------------------------

// Only the RANDOM generator is mocked. `validateCustomSlug` must stay real:
// slug validation is a pure rule set, and testing it against a mock would assert
// only that the mock was called.
vi.mock("../../src/utils/short-code", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/utils/short-code")>();
  return { ...actual, generateShortCode: vi.fn() };
});

import { withClient } from "../../src/db/client";
import {
  setCachedUrl,
  invalidateCachedUrl,
  getCachedRegistryEntry,
  setCachedRegistryEntry,
  invalidateCachedRegistryEntry,
} from "../../src/cache/shortcode";
import { generateShortCode } from "../../src/utils/short-code";
import { createLink, deleteLink, linkClicks, listLinks, updateLink, DEFAULT_MAX_ACTIVE_LINKS, DEFAULT_MAX_CARD_STOCK } from "../../src/api/links";
import { UNIQUE_WINDOW, SESSION_WINDOW } from "../../src/analytics/metrics";
import { ValidationError } from "../../src/middleware/error";

// ---------------------------------------------------------------------------
// Helper: mock Hono context
// ---------------------------------------------------------------------------

function mockContext(overrides: {
  tenant?: { tenantSlug: string; schemaName: string; tenantId: string };
  body?: object;
  jsonParseError?: boolean;
  params?: Record<string, string>;
  /** Extra bindings merged over the default env — e.g. MAX_ACTIVE_LINKS. */
  env?: Record<string, string>;
} = {}) {
  const waitUntilFn = vi.fn();
  const jsonFn = vi.fn().mockImplementation(
    (body: unknown, status: number) => new Response(JSON.stringify(body), { status }),
  );
  const redirectFn = vi.fn().mockImplementation(
    (url: string, status: number) =>
      new Response(null, { status, headers: { Location: url } }),
  );

  const c = {
    req: {
      json: overrides.jsonParseError
        ? vi.fn().mockRejectedValue(new Error("Invalid JSON"))
        : vi.fn().mockResolvedValue(overrides.body ?? {}),
      param: vi.fn().mockImplementation(
        (key: string) => overrides.params?.[key] ?? "",
      ),
    },
    env: {
      SHORT_URL_DOMAIN: "short.link",
      SUPABASE_JWT_SECRET: "test-secret",
      SUPABASE_URL: "https://test.supabase.co",
      SUPABASE_ANON_KEY: "test-anon-key",
      SUPABASE_SERVICE_ROLE_KEY: "test-service-key",
      SHORT_URL_CACHE: {} as any,
      ...overrides.env,
    },
    json: jsonFn,
    redirect: redirectFn,
    get: vi.fn().mockImplementation((key: string) => {
      if (key === "tenant") return overrides.tenant ?? {
        tenantSlug: "acme",
        schemaName: "tenant_a7f3",
        tenantId: "tenant-uuid",
      };
      return undefined;
    }),
    executionCtx: {
      waitUntil: waitUntilFn,
    },
  };

  return { c, jsonFn, redirectFn, waitUntilFn };
}

// ---------------------------------------------------------------------------
// Helper: mock a DB client for withClient
// ---------------------------------------------------------------------------

function mockDbClient(queryResult: any) {
  return vi.mocked(withClient).mockImplementationOnce(async (_env: any, fn: any) => {
    return fn({
      query: vi.fn().mockResolvedValueOnce(queryResult),
    });
  });
}

// ---------------------------------------------------------------------------
// Links API tests (REQ-L001, REQ-L002, REQ-S002)
// ---------------------------------------------------------------------------

describe("createLink handler", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(generateShortCode).mockReturnValue("abc1234");
    mockCacheDefaults();
  });

  it("returns 201 with the created link resource (happy path)", async () => {
    let callCount = 0;
    vi.mocked(withClient).mockImplementation(async (_env: any, fn: any) => {
      callCount++;
      if (callCount === 1) {
        // COUNT query: 5 active links
        return fn({
          query: vi.fn().mockResolvedValueOnce({ rows: [{ configured: "5", stock: "0" }], rowCount: 1 }),
        });
      }
      // INSERT query (success), then the registry claim on the same client.
      // Both statements share one mock, so the results are queued in order.
      return fn({
        query: vi.fn()
          .mockResolvedValueOnce({
            rows: [
              {
                id: "link-uuid",
                short_code: "abc1234",
                original_url: "https://example.com",
                title: null,
                created_at: "2026-01-01T00:00:00Z",
              },
            ],
            rowCount: 1,
          })
          .mockResolvedValueOnce({ rows: [{ short_code: "abc1234" }], rowCount: 1 }),
      });
    });

    const { c, jsonFn, waitUntilFn } = mockContext({
      body: { original_url: "https://example.com" },
    });

    await createLink(c as any);

    expect(jsonFn).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "link-uuid",
        short_code: "abc1234",
        original_url: "https://example.com",
        // Flat: no /r/ prefix and no tenant slug in the public URL
        short_url: "https://short.link/abc1234",
        title: null,
        expires_at: null,
      }),
      201,
    );
    // KV cache warm via waitUntil
    expect(waitUntilFn).toHaveBeenCalled();
    expect(setCachedUrl).toHaveBeenCalled();
  });

  it("returns 400 for invalid URL", async () => {
    // validateUrl runs before withClient, so DB is never reached

    const { c } = mockContext({
      body: { original_url: "not-a-url" },
    });

    // The handler throws ValidationError (before using withClient)
    await expect(createLink(c as any)).rejects.toThrow();
    expect(withClient).not.toHaveBeenCalled();
  });

  it("returns 429 when at the configured active links limit", async () => {
    vi.mocked(withClient).mockImplementation(async (_env: any, fn: any) => {
      return fn({
        query: vi.fn().mockResolvedValueOnce({ rows: [{ configured: "30", stock: "0" }], rowCount: 1 }),
      });
    });

    const { c } = mockContext({
      // T3.1: 30 is no longer the built-in cap. Pinning it here as an
      // operator-configured value keeps the original scenario intact while
      // exercising the env read rather than a constant.
      env: { MAX_ACTIVE_LINKS: "30" },
      body: { original_url: "https://example.com" },
    });

    await expect(createLink(c as any)).rejects.toThrow("limit");
  });

  it("retries on short code collision and succeeds on 2nd attempt", async () => {
    let callCount = 0;

    vi.mocked(withClient).mockImplementation(async (_env: any, fn: any) => {
      callCount++;
      if (callCount === 1) {
        // COUNT query: 10 active links
        return fn({
          query: vi.fn().mockResolvedValueOnce({ rows: [{ configured: "10", stock: "0" }], rowCount: 1 }),
        });
      }
      if (callCount === 2) {
        // First INSERT: collision (rowCount 0)
        return fn({
          query: vi.fn().mockResolvedValueOnce({ rows: [], rowCount: 0 }),
        });
      }
      // Second attempt: link INSERT succeeds, then the registry claim succeeds
      return fn({
        query: vi.fn()
          .mockResolvedValueOnce({
            rows: [
              {
                id: "link-uuid",
                short_code: "xyz5678",
                original_url: "https://example.com",
                title: null,
                created_at: "2026-01-01T00:00:00Z",
              },
            ],
            rowCount: 1,
          })
          .mockResolvedValueOnce({ rows: [{ short_code: "xyz5678" }], rowCount: 1 }),
      });
    });

    // First short code: collision, second: success
    vi.mocked(generateShortCode)
      .mockReturnValueOnce("abc1234")
      .mockReturnValueOnce("xyz5678");

    const { c, jsonFn } = mockContext({
      body: { original_url: "https://example.com" },
    });

    await createLink(c as any);

    expect(jsonFn).toHaveBeenCalledWith(
      expect.objectContaining({ short_code: "xyz5678" }),
      201,
    );
    expect(callCount).toBe(3);
  });

  it("returns 500 after 3 exhausted retries", async () => {
    let callCount = 0;

    vi.mocked(withClient).mockImplementation(async (_env: any, fn: any) => {
      callCount++;
      if (callCount === 1) {
        // COUNT query
        return fn({
          query: vi.fn().mockResolvedValueOnce({ rows: [{ configured: "10", stock: "0" }], rowCount: 1 }),
        });
      }
      // All 3 INSERT attempts: collision (rowCount 0)
      return fn({
        query: vi.fn().mockResolvedValueOnce({ rows: [], rowCount: 0 }),
      });
    });

    const { c } = mockContext({
      body: { original_url: "https://example.com" },
    });

    await expect(createLink(c as any)).rejects.toThrow("link_creation_failed");
    expect(callCount).toBe(4); // COUNT + 3 inserts
  });

  it("accepts optional title and expires_at", async () => {
    let callCount = 0;
    vi.mocked(withClient).mockImplementation(async (_env: any, fn: any) => {
      callCount++;
      if (callCount === 1) {
        return fn({
          query: vi.fn().mockResolvedValueOnce({ rows: [{ configured: "0", stock: "0" }], rowCount: 1 }),
        });
      }
      // Link INSERT succeeds, then the registry claim succeeds
      return fn({
        query: vi.fn()
          .mockResolvedValueOnce({
            rows: [
              {
                id: "link-uuid",
                short_code: "abc1234",
                original_url: "https://example.com",
                title: "My Link",
                created_at: "2026-01-01T00:00:00Z",
              },
            ],
            rowCount: 1,
          })
          .mockResolvedValueOnce({ rows: [{ short_code: "abc1234" }], rowCount: 1 }),
      });
    });

    const { c, jsonFn } = mockContext({
      body: {
        original_url: "https://example.com",
        title: "My Link",
        expires_at: "2026-12-31T23:59:59Z",
      },
    });

    await createLink(c as any);

    expect(jsonFn).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "My Link",
        expires_at: "2026-12-31T23:59:59Z",
      }),
      201,
    );
  });

  it("counts only active links (inactive excluded)", async () => {
    let callCount = 0;
    vi.mocked(withClient).mockImplementation(async (_env: any, fn: any) => {
      callCount++;
      if (callCount === 1) {
        // COUNT query: 29 active links (under limit)
        return fn({
          query: vi.fn().mockResolvedValueOnce({ rows: [{ configured: "29", stock: "0" }], rowCount: 1 }),
        });
      }
      // Link INSERT succeeds, then the registry claim succeeds
      return fn({
        query: vi.fn()
          .mockResolvedValueOnce({
            rows: [
              {
                id: "link-uuid",
                short_code: "abc1234",
                original_url: "https://example.com",
                title: null,
                created_at: "2026-01-01T00:00:00Z",
              },
            ],
            rowCount: 1,
          })
          .mockResolvedValueOnce({ rows: [{ short_code: "abc1234" }], rowCount: 1 }),
      });
    });

    const { c, jsonFn } = mockContext({
      body: { original_url: "https://example.com" },
    });

    await createLink(c as any);

    expect(jsonFn).toHaveBeenCalledWith(expect.any(Object), 201);
  });
});

// ---------------------------------------------------------------------------
// linkClicks handler tests (GET /api/links/:id/clicks)
// ---------------------------------------------------------------------------

interface ClickRow {
  country_code: string | null;
  device_type: string | null;
  referrer: string | null;
  referrer_source: string | null;
  created_at: string;
}

/**
 * Mocks the analytics query surface for linkClicks.
 *
 * `grouped` stands in for the unbounded GROUP BY aggregate (all rows for the
 * link); `recent` stands in for the recent-N projection; `visitors` for the
 * single distinct-count query behind `unique_visitors` / `sessions`. Each SQL
 * text selects which one is returned, so the handler's query shape drives the
 * mock rather than a brittle call-order sequence.
 */
function mockClicksDb(opts: {
  grouped: unknown[];
  recent: unknown[];
  linkExists?: boolean;
  aggregateThrows?: boolean;
  /** Row the visitor aggregate returns; defaults to a link with no traffic. */
  visitors?: { unique_visitors: number | string; sessions: number | string };
}) {
  const calls: string[] = [];
  /** SQL paired with its bind params, for the window-constant assertions. */
  const bound: { sql: string; params: unknown[] }[] = [];

  vi.mocked(withClient).mockImplementation(async (_env: any, fn: any) =>
    fn({
      query: vi.fn().mockImplementation(async (sql: string, params: unknown[] = []) => {
        calls.push(sql);
        bound.push({ sql, params });
        if (sql.includes("SELECT id FROM")) {
          return { rows: opts.linkExists === false ? [] : [{ id: "link-uuid" }] };
        }
        // Checked before GROUP BY so a visitor query carrying one still routes
        // to the visitor row.
        if (sql.includes("ip_hash")) {
          return {
            rows: [opts.visitors ?? { unique_visitors: 0, sessions: 0 }],
          };
        }
        if (sql.includes("GROUP BY")) {
          // Only the referrer_source variant fails; the fallback shape still works
          if (opts.aggregateThrows && sql.includes("referrer_source")) {
            throw new Error('column "referrer_source" does not exist');
          }
          return { rows: opts.grouped };
        }
        return { rows: opts.recent };
      }),
    }),
  );

  return { calls, bound };
}

/** Builds one recent-click row with sensible defaults. */
function recentClick(over: Partial<ClickRow> = {}): ClickRow {
  return {
    country_code: "US",
    device_type: "desktop",
    referrer: "https://news.example",
    referrer_source: "News",
    created_at: "2026-01-01T00:00:00Z",
    ...over,
  };
}

describe("linkClicks handler", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockCacheDefaults();
  });

  it("reports the true total and aggregates every row when clicks exceed 50", async () => {
    // Aggregate view of 137 clicks — far beyond any single fetch window.
    mockClicksDb({
      grouped: [
        { country_code: "US", device_type: "mobile", referrer_source: "News", count: 120 },
        { country_code: "AR", device_type: "desktop", referrer_source: null, count: 17 },
      ],
      recent: Array.from({ length: 10 }, (_, i) =>
        recentClick({ created_at: `2026-02-0${i + 1}T00:00:00Z` }),
      ),
    });

    const { c, jsonFn } = mockContext({ params: { id: "link-uuid" } });

    await linkClicks(c as any);

    expect(jsonFn).toHaveBeenCalledWith(
      expect.objectContaining({
        total: 137,
        by_country: { US: 120, AR: 17 },
        by_device: { mobile: 120, desktop: 17 },
        // null referrer_source falls back to "Direct"
        by_source: { News: 120, Direct: 17 },
      }),
    );
  });

  it("never issues a bounded SELECT over analytics.link_clicks for the breakdowns", async () => {
    const { calls } = mockClicksDb({
      grouped: [{ country_code: "US", device_type: "mobile", referrer_source: "News", count: 2 }],
      recent: [recentClick()],
    });

    const { c } = mockContext({ params: { id: "link-uuid" } });
    await linkClicks(c as any);

    const clickQueries = calls.filter((q) => q.includes("analytics.link_clicks"));
    expect(clickQueries.length).toBeGreaterThan(0);
    for (const q of clickQueries) {
      // The old defect capped breakdowns at 50 rows via `LIMIT 50`
      expect(q).not.toContain("LIMIT 50");
    }
  });

  it("returns only the recent-N window in the recent array", async () => {
    mockClicksDb({
      grouped: [
        { country_code: "US", device_type: "mobile", referrer_source: "News", count: 100 },
      ],
      recent: Array.from({ length: 3 }, (_, i) =>
        recentClick({ created_at: `2026-03-0${i + 1}T00:00:00Z` }),
      ),
    });

    const { c, jsonFn } = mockContext({ params: { id: "link-uuid" } });
    await linkClicks(c as any);

    expect(jsonFn).toHaveBeenCalledWith(
      expect.objectContaining({
        total: 100,
        recent: [
          { country: "US", device: "desktop", referrer: "https://news.example", time: "2026-03-01T00:00:00Z" },
          { country: "US", device: "desktop", referrer: "https://news.example", time: "2026-03-02T00:00:00Z" },
          { country: "US", device: "desktop", referrer: "https://news.example", time: "2026-03-03T00:00:00Z" },
        ],
      }),
    );
  });

  it("applies Unknown fallbacks for null country and device on the aggregate", async () => {
    mockClicksDb({
      grouped: [
        { country_code: null, device_type: null, referrer_source: "Social", count: 5 },
      ],
      recent: [recentClick({ country_code: null, device_type: null, referrer: null })],
    });

    const { c, jsonFn } = mockContext({ params: { id: "link-uuid" } });
    await linkClicks(c as any);

    expect(jsonFn).toHaveBeenCalledWith(
      expect.objectContaining({
        total: 5,
        by_country: { Unknown: 5 },
        by_device: { Unknown: 5 },
        by_source: { Social: 5 },
        recent: [
          { country: "Unknown", device: "Unknown", referrer: "Direct", time: "2026-01-01T00:00:00Z" },
        ],
      }),
    );
  });

  it("coerces the aggregate count to a number regardless of driver string encoding", async () => {
    // The pg driver returns COUNT(*) as a string unless explicitly cast
    mockClicksDb({
      grouped: [
        { country_code: "US", device_type: "mobile", referrer_source: "News", count: "3" },
      ],
      recent: [],
    });

    const { c, jsonFn } = mockContext({ params: { id: "link-uuid" } });
    await linkClicks(c as any);

    expect(jsonFn).toHaveBeenCalledWith(
      expect.objectContaining({
        total: 3,
        by_country: { US: 3 },
        by_device: { mobile: 3 },
        by_source: { News: 3 },
      }),
    );
  });

  it("falls back to an aggregate without referrer_source when the column is missing", async () => {
    mockClicksDb({
      aggregateThrows: true,
      grouped: [
        { country_code: "US", device_type: "mobile", count: 9 },
      ],
      recent: [recentClick()],
    });

    const { c, jsonFn } = mockContext({ params: { id: "link-uuid" } });
    await linkClicks(c as any);

    expect(jsonFn).toHaveBeenCalledWith(
      expect.objectContaining({
        total: 9,
        by_country: { US: 9 },
        by_device: { mobile: 9 },
        // every row degrades to "Direct" when the column is unavailable
        by_source: { Direct: 9 },
      }),
    );
  });

  it("throws NotFound when the link does not exist", async () => {
    mockClicksDb({ linkExists: false, grouped: [], recent: [] });

    const { c } = mockContext({ params: { id: "missing-link" } });

    await expect(linkClicks(c as any)).rejects.toThrow("not found");
  });
});

// ---------------------------------------------------------------------------
// Unique visitors and sessions (T2.1 — T2.3)
//
// Both figures are COUNT(DISTINCT ip_hash) over the same rolling horizon. The
// difference is the bucket:
//   unique_visitors — one count for the whole day
//   sessions        — one count per 30-minute slice of that day
//
// ip_hash is SHA-256(ip + per-tenant salt), so the same person tapping a tag
// three times in a row is recognisable across those taps with no cookie and no
// consent banner. Both figures remain a PESSIMISTIC LOWER BOUND — see the
// shared-IP case below, which asserts the undercount rather than hiding it.
// ---------------------------------------------------------------------------

describe("unique visitors and sessions", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockCacheDefaults();
  });

  /**
   * THE CASE THAT SEPARATES THE TWO METRICS.
   *
   * One person, three taps in a row inside a single half hour. The daily unique
   * count is 1 — they are one person. The session count is also 1, and that is
   * the assertion doing the work: if the 30-minute bucket were missing, dropped,
   * or replaced by a second plain distinct count, this would report 3 sessions
   * and the distinction between the two figures would be decorative.
   */
  it("collapses three rapid taps by one visitor to a single session, and to one daily unique visitor", async () => {
    // The SQL dedups on the PAIR (ip_hash, 30-minute bucket), so three taps in
    // one bucket collapse onto one row and COUNT(*) over that row set is 1.
    mockClicksDb({
      grouped: [{ country_code: "ES", device_type: "mobile", referrer_source: "Direct", count: 3 }],
      recent: Array.from({ length: 3 }, (_, i) =>
        recentClick({ created_at: `2026-04-0${i + 1}T12:0${i}:00Z` }),
      ),
      visitors: { unique_visitors: 1, sessions: 1 },
    });

    const { c, jsonFn } = mockContext({ params: { id: "link-uuid" } });

    await linkClicks(c as any);

    // Raw taps are still reported as three — the collapse is scoped to the two
    // visitor figures and must not quietly redefine "total".
    expect(jsonFn).toHaveBeenCalledWith(
      expect.objectContaining({
        total: 3,
        unique_visitors: 1,
        sessions: 1,
      }),
    );
  });

  /**
   * THE SAME PERSON ACROSS SEPARATE HALF HOURS IS TWO VISITS, NOT ONE.
   *
   * The counterpart to the collapse case. Without this, an implementation that
   * simply divided by an arbitrary number would pass the test above.
   */
  it("counts one visitor as two sessions when the taps fall in different 30-minute buckets", async () => {
    mockClicksDb({
      grouped: [{ country_code: "ES", device_type: "mobile", referrer_source: "Direct", count: 2 }],
      recent: [],
      visitors: { unique_visitors: 1, sessions: 2 },
    });

    const { c, jsonFn } = mockContext({ params: { id: "link-uuid" } });

    await linkClicks(c as any);

    expect(jsonFn).toHaveBeenCalledWith(
      expect.objectContaining({ unique_visitors: 1, sessions: 2 }),
    );
  });

  /**
   * SHARED-IP SCENARIO — ASSERTED AS A KNOWN UNDERCOUNT.
   *
   * This test exists to pin the limitation, NOT to imply it is solved. A cafe
   * on one public IP puts forty people through the door; forty clicks carrying
   * a single ip_hash produce `unique_visitors: 1`. There is no signal in the
   * row that separates "one person tapping three times" from "forty people
   * behind a NAT", and resolving it would require a cookie or a first-party
   * identifier — a trade this feature explicitly refuses.
   *
   * So the honest statement is: the system reports 1, the store served 40, and
   * the number is documented as a lower bound in the UI next to the figure.
   * Anyone who later "fixes" this by storing an identifier should have to come
   * back here and confront the cost.
   */
  it("reports 1 unique visitor for 40 clicks sharing one ip_hash — a known undercount, not a solved case", async () => {
    mockClicksDb({
      // 40 taps, all from the same public IP (cafe Wi-Fi / carrier CGNAT).
      grouped: [{ country_code: "ES", device_type: "mobile", referrer_source: "Direct", count: 40 }],
      recent: [],
      visitors: { unique_visitors: 1, sessions: 1 },
    });

    const { c, jsonFn } = mockContext({ params: { id: "link-uuid" } });

    await linkClicks(c as any);

    expect(jsonFn).toHaveBeenCalledWith(
      expect.objectContaining({
        // Raw taps are truthful...
        total: 40,
        // ...but the visitor figure says 1 for 40 real people. This is the
        // ceiling of the metric, asserted rather than papered over.
        unique_visitors: 1,
      }),
    );
  });

  describe("T2.1 — windows are named constants, bound as parameters", () => {
    it("pins the documented window values", () => {
      expect(UNIQUE_WINDOW).toBe("1 day");
      expect(SESSION_WINDOW).toBe("30 minutes");
    });

    it("binds both windows rather than interpolating them into the SQL text", async () => {
      const { bound } = mockClicksDb({ grouped: [], recent: [] });
      await linkClicks(mockContext({ params: { id: "link-uuid" } }).c as any);

      const visitorQuery = bound.find((q) => q.sql.includes("ip_hash"))!;
      expect(visitorQuery).toBeDefined();
      // $1 is the link, $2 the horizon, $3 the bucket width.
      expect(visitorQuery.params).toEqual(["link-uuid", UNIQUE_WINDOW, SESSION_WINDOW]);

      // A bound interval cannot be altered by a stray quote, and the constants
      // have exactly one home.
      expect(visitorQuery.sql).not.toContain(UNIQUE_WINDOW);
      expect(visitorQuery.sql).not.toContain(SESSION_WINDOW);
      expect(visitorQuery.sql).toContain("CAST($2 AS interval)");
      expect(visitorQuery.sql).toContain("CAST($3 AS interval)");
    });

    it("reports the windows in the response so the UI cannot label a stale number", async () => {
      mockClicksDb({ grouped: [], recent: [], visitors: { unique_visitors: 2, sessions: 3 } });
      const { c, jsonFn } = mockContext({ params: { id: "link-uuid" } });

      await linkClicks(c as any);

      expect(jsonFn).toHaveBeenCalledWith(
        expect.objectContaining({
          unique_window: UNIQUE_WINDOW,
          session_window: SESSION_WINDOW,
        }),
      );
    });
  });

  describe("T2.2 — computed in SQL, per link", () => {
    it("filters by the requested link_id rather than aggregating the tenant", async () => {
      const { bound } = mockClicksDb({ grouped: [], recent: [] });
      await linkClicks(mockContext({ params: { id: "link-uuid" } }).c as any);

      const visitorQuery = bound.find((q) => q.sql.includes("ip_hash"))!;
      expect(visitorQuery.sql).toMatch(/WHERE c\.link_id = \$1/);
      // No tenant-wide scope creep: the horizon predicate must stay in place.
      expect(visitorQuery.sql).toMatch(/c\.created_at >= NOW\(\) - CAST\(\$2 AS interval\)/);
    });

    it("buckets on floor() so a click exactly on the boundary joins the LATER window", async () => {
      const { bound } = mockClicksDb({ grouped: [], recent: [] });
      await linkClicks(mockContext({ params: { id: "link-uuid" } }).c as any);

      const visitorQuery = bound.find((q) => q.sql.includes("ip_hash"))!;
      // floor, not round and not date_trunc('minute'): a click landing on
      // 12:30:00.000 belongs to the 12:30 bucket, not the 12:00 one, because
      // at that instant the visitor is still on site.
      expect(visitorQuery.sql).toMatch(/floor\(extract\(epoch FROM c\.created_at\)/);
      expect(visitorQuery.sql).not.toMatch(/round\(/);
      // Fixed-width epoch buckets — UTC-anchored, so the boundary does not move
      // with the database session's time zone between two requests.
      expect(visitorQuery.sql).toMatch(/extract\(epoch FROM CAST\(\$3 AS interval\)\)/);
    });

    it("treats the window as half-open: a click on the 30-minute edge is a new session", async () => {
      // The exact boundary property, stated once so it is not left implicit.
      //
      // HONEST SCOPE: this mirrors the SQL's bucket expression in JavaScript —
      // it does NOT execute Postgres, and cannot in this suite. What it pins is
      // the documented contract the SQL must keep satisfying: the bucket is
      // floor(epoch / stride) * stride, so a click at exactly t + 30 minutes
      // lands in bucket k+1 rather than k. That is what "a click at the edge of
      // the window falls OUTSIDE it" means — the window is [k, k+1), not the
      // closed [k, k+1].
      //
      // The structural guards above (floor present, no round, divisor AND
      // multiplier equal to the bound stride) are what tie this mirror to the
      // shipped SQL; without them the mirror would only be testing itself.
      const strideSeconds = 30 * 60;
      const bucket = (iso: string) => {
        const epoch = Date.parse(iso) / 1000;
        return Math.floor(epoch / strideSeconds) * strideSeconds;
      };

      const t0 = Date.parse("2026-05-01T12:00:00.000Z") / 1000;
      // Exactly one stride later.
      const edge = new Date((t0 + strideSeconds) * 1000).toISOString();

      expect(bucket(edge)).not.toBe(bucket("2026-05-01T12:00:00.000Z"));
      // One millisecond BEFORE the edge is still the original window.
      const justInside = new Date((t0 + strideSeconds - 0.001) * 1000).toISOString();
      expect(bucket(justInside)).toBe(bucket("2026-05-01T12:00:00.000Z"));
    });

    it("de-duplicates on the (visitor, bucket) PAIR in a derived table", async () => {
      const { bound } = mockClicksDb({ grouped: [], recent: [] });
      await linkClicks(mockContext({ params: { id: "link-uuid" } }).c as any);

      const visitorQuery = bound.find((q) => q.sql.includes("ip_hash"))!;

      // Both figures read the same de-duplicated rows: COUNT(DISTINCT ip_hash)
      // for the day, COUNT(*) for the sessions.
      expect(visitorQuery.sql).toMatch(/SELECT DISTINCT\s+c\.ip_hash,/);
      expect(visitorQuery.sql).toMatch(/COUNT\(DISTINCT s\.ip_hash\)::int AS unique_visitors/);
      expect(visitorQuery.sql).toMatch(/COUNT\(\*\)::int\s+AS sessions/);

      // The part that actually makes the collapse work. If the bucket were
      // computed AFTER the DISTINCT — or left out of the projection entirely —
      // the derived table would hold one row per raw tap, COUNT(*) would return
      // the total, and "sessions" would silently be a second copy of "total"
      // rather than a count of visits.
      const projection = visitorQuery.sql.slice(
        visitorQuery.sql.indexOf("SELECT DISTINCT"),
        visitorQuery.sql.indexOf("FROM analytics.link_clicks"),
      );
      expect(projection).toMatch(/\bc\.ip_hash\b/);
      expect(projection).toMatch(/session_bucket/);
      // And it is an aggregate over that subquery, not over the raw table.
      expect(visitorQuery.sql).toMatch(/COUNT\(\*\)::int\s+AS sessions\s+FROM \(\s*SELECT DISTINCT/);
    });

    it("never folds buckets in JavaScript and never samples a bounded row set", async () => {
      const { calls } = mockClicksDb({ grouped: [], recent: [] });
      await linkClicks(mockContext({ params: { id: "link-uuid" } }).c as any);

      const visitorQuery = calls.find((q) => q.includes("ip_hash"))!;
      // The pre-Phase-0 defect counted a LIMIT 50 sample and reported
      // rows.length as the total. The visitor aggregate must never sample, and
      // must never be handed back to JS to be folded.
      expect(visitorQuery).not.toContain("LIMIT");
      expect(visitorQuery).not.toContain("ORDER BY");
    });

    it("excludes clicks with no ip_hash, which cannot be attributed to a person", async () => {
      const { bound } = mockClicksDb({ grouped: [], recent: [] });
      await linkClicks(mockContext({ params: { id: "link-uuid" } }).c as any);

      const visitorQuery = bound.find((q) => q.sql.includes("ip_hash"))!;
      // COUNT(DISTINCT) already drops nulls, but the session figure is a
      // COUNT(*) — without this filter a click with no resolvable IP would be
      // counted as a person walking in.
      expect(visitorQuery.sql).toMatch(/c\.ip_hash IS NOT NULL/);
    });
  });

  describe("T2.3 — backward-compatible response", () => {
    it("keeps total, by_country, by_device, by_source and recent exactly as they were", async () => {
      mockClicksDb({
        grouped: [{ country_code: "US", device_type: "mobile", referrer_source: "News", count: 7 }],
        recent: [recentClick()],
        visitors: { unique_visitors: 4, sessions: 5 },
      });

      const { c, jsonFn } = mockContext({ params: { id: "link-uuid" } });
      await linkClicks(c as any);

      expect(jsonFn).toHaveBeenCalledWith({
        total: 7,
        unique_visitors: 4,
        sessions: 5,
        unique_window: UNIQUE_WINDOW,
        session_window: SESSION_WINDOW,
        by_country: { US: 7 },
        by_device: { mobile: 7 },
        by_source: { News: 7 },
        recent: [
          {
            country: "US",
            device: "desktop",
            referrer: "https://news.example",
            time: "2026-01-01T00:00:00Z",
          },
        ],
      });
    });

    it("coerces string-encoded counts to numbers", async () => {
      // The pg driver returns COUNT as a bigint, which may arrive as a string.
      mockClicksDb({
        grouped: [],
        recent: [],
        visitors: { unique_visitors: "12", sessions: "30" },
      });

      const { c, jsonFn } = mockContext({ params: { id: "link-uuid" } });
      await linkClicks(c as any);

      expect(jsonFn).toHaveBeenCalledWith(
        expect.objectContaining({ unique_visitors: 12, sessions: 30 }),
      );
    });

    it("reports zero rather than omitting the figures for a link with no traffic", async () => {
      mockClicksDb({ grouped: [], recent: [] });

      const { c, jsonFn } = mockContext({ params: { id: "link-uuid" } });
      await linkClicks(c as any);

      // An absent figure would render as "undefined" in the dashboard and read
      // as "we have no data" rather than "nobody came".
      expect(jsonFn).toHaveBeenCalledWith(
        expect.objectContaining({ total: 0, unique_visitors: 0, sessions: 0 }),
      );
    });
  });
});

// ---------------------------------------------------------------------------
// REGRESSION GUARD — GET /api/links returns a BARE ARRAY
//
// Phase 2 wrapped this endpoint in `{ links, clients }` so the per-client_ref
// rollup could ride along in the same response. That was a breaking change no
// consumer asked for: every caller written against the original contract — the
// dashboard, and the CRM integration this project is heading toward — receives
// an object where it expects a collection and fails on it.
//
// The rollup now has its own endpoint (src/api/clients.ts), so there is nothing
// left to carry and the original shape is restored exactly.
//
// This assertion is deliberately structural rather than a snapshot: it fails on
// ANY wrapping, so a future change cannot reintroduce an envelope by adding a
// field and re-checking an updated snapshot.
// ---------------------------------------------------------------------------

describe("listLinks response shape", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns a bare JSON array, not an envelope object", async () => {
    mockRecordingDb([
      [
        {
          id: "link-1",
          short_code: "aaa1111",
          original_url: "https://example.com",
          title: null,
          client_ref: "ACME-0042",
          clicks_count: 7,
          is_active: true,
          expires_at: null,
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-02T00:00:00Z",
        },
      ],
    ]);

    const { c, jsonFn } = mockContext();

    await listLinks(c as any);

    const body = jsonFn.mock.calls[0]![0];
    // The whole contract in one line: an array. `{ links: [...] }` is not.
    expect(Array.isArray(body)).toBe(true);
    expect(body).not.toHaveProperty("links");
    expect(body).not.toHaveProperty("clients");
  });

  it("serializes to a top-level JSON array on the wire", async () => {
    mockRecordingDb([
      [
        {
          id: "link-1",
          short_code: "aaa1111",
          original_url: "https://example.com",
          title: null,
          client_ref: null,
          clicks_count: 7,
          is_active: true,
          expires_at: null,
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-02T00:00:00Z",
        },
      ],
    ]);

    const { c } = mockContext();

    const res = (await listLinks(c as any)) as Response;

    // The assertion above checks what was handed to c.json; this checks what a
    // client would actually parse. A wrapper added at serialization time would
    // pass the first and fail this one.
    await expect(res.json()).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "link-1" })]),
    );
  });

  it("returns an empty array, not an empty object, when the tenant has no links", async () => {
    mockRecordingDb([[]]);

    const { c, jsonFn } = mockContext();

    await listLinks(c as any);

    expect(jsonFn.mock.calls[0]![0]).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // T1.4 — location on the list response
  // -------------------------------------------------------------------------

  it("returns location_id and location_name so the dashboard needs no second round trip", async () => {
    mockRecordingDb([
      [
        {
          id: "link-1",
          short_code: "mesa-01",
          original_url: "https://example.com",
          title: null,
          client_ref: null,
          location_id: "loc-1",
          location_name: "Mesa 1",
          clicks_count: 7,
          is_active: true,
          expires_at: null,
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-02T00:00:00Z",
        },
      ],
    ]);

    const { c, jsonFn } = mockContext();

    await listLinks(c as any);

    expect(jsonFn.mock.calls[0]![0]).toEqual([
      expect.objectContaining({
        location_id: "loc-1",
        location_name: "Mesa 1",
      }),
    ]);
  });

  it("returns nulls, not undefined, for a link with no location assigned", async () => {
    mockRecordingDb([
      [
        {
          id: "link-1",
          short_code: "aaa1111",
          original_url: "https://example.com",
          title: null,
          client_ref: null,
          location_id: null,
          location_name: null,
          clicks_count: 0,
          is_active: true,
          expires_at: null,
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-02T00:00:00Z",
        },
      ],
    ]);

    const { c, jsonFn } = mockContext();

    await listLinks(c as any);

    const [row] = jsonFn.mock.calls[0]![0] as Record<string, unknown>[];
    // `undefined` disappears from the JSON payload entirely, so a client
    // reading `row.location_id` gets a missing key rather than a null.
    expect(row).toHaveProperty("location_id", null);
    expect(row).toHaveProperty("location_name", null);
  });

  it("joins public.locations with a LEFT JOIN so unassigned links still appear", async () => {
    const calls = mockRecordingDb([[]]);

    const { c } = mockContext();

    await listLinks(c as any);

    const sql = calls[0]!.sql;
    expect(sql).toMatch(/LEFT\s+JOIN\s+public\.locations/i);
    expect(sql).toMatch(/location_name/i);
    // An INNER JOIN would silently drop every link the owner has not placed
    // yet, which is most of them on day one.
    expect(sql).not.toMatch(/INNER\s+JOIN/i);
  });
});

// ---------------------------------------------------------------------------
// T2.4 — per-client_ref rollup
//
// `client_ref` is the per-store identifier, so this is the view that answers
// "how much footfall did THIS shop get". It cannot be assembled by summing the
// per-link figures in JavaScript: a person who scans two tags at one store is
// one visitor there, not two, and only a distinct count across the whole ref
// knows that.
//
// The rollup lives on its own endpoint now (test/api/clients.test.ts), so these
// assertions cover what listLinks must NOT do: run the rollup query at all.
// ---------------------------------------------------------------------------

describe("client_ref visitor rollup is not part of listLinks", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("issues exactly one query — the links list — with no rollup aggregate", async () => {
    const calls = mockRecordingDb([[], []]);

    const { c } = mockContext();
    await listLinks(c as any);

    // The rollup moved to GET /api/clients/metrics. Its coverage lives in
    // test/api/clients.test.ts; what matters here is that this endpoint stops
    // paying for a second aggregate it no longer returns.
    expect(calls).toHaveLength(1);
    expect(calls.some((q) => /GROUP BY s\.client_ref/.test(q.sql))).toBe(false);
    expect(calls.some((q) => /client_ref IS NOT NULL/.test(q.sql))).toBe(false);
  });

  it("binds every placeholder the links query references", async () => {
    // Regression guard for a real defect found while writing these tests: the
    // session-bucket expression was shared between the two queries with a
    // hardcoded `$3`, so the rollup referenced a placeholder it never bound.
    // Postgres rejects that at execution time, long after typecheck and unit
    // tests are green — so the invariant is asserted directly.
    const calls = mockRecordingDb([[], []]);
    await listLinks(mockContext().c as any);

    for (const q of calls) {
      // A placeholder may legitimately appear more than once, so the invariant
      // is about the DISTINCT set being contiguous from 1, not about occurrences.
      const referenced = new Set(
        [...q.sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])),
      );
      const highest = Math.max(0, ...referenced);
      // Postgres parameters are 1-indexed and contiguous.
      expect(q.params.length).toBe(highest);
      expect([...referenced].sort((a, b) => a - b)).toEqual(
        Array.from({ length: highest }, (_, i) => i + 1),
      );
    }
  });

  it("binds every placeholder the link visitor SQL references", async () => {
    const { bound } = mockClicksDb({ grouped: [], recent: [] });
    await linkClicks(mockContext({ params: { id: "link-uuid" } }).c as any);

    const visitorQuery = bound.find((q) => q.sql.includes("ip_hash"))!;
    const referenced = [...visitorQuery.sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
    expect(visitorQuery.params.length).toBe(Math.max(...referenced));
  });
});

// ---------------------------------------------------------------------------
// client_ref — user-defined CRM identifier (T1.4)
//
// Contract under test:
//   - optional; omitting it is NOT an error (existing links have none)
//   - stored verbatim on create, on the INSERT itself
//   - patchable on update via the same PATCH endpoint as is_active/title
//   - must be a string; anything else is a 400 ValidationError
//   - returned by listLinks so the dashboard can render it
// ---------------------------------------------------------------------------

/**
 * Records the SQL text and bind params of every query the handler issues, and
 * returns each queued ROW ARRAY in call order. `query()` resolves to
 * `{ rows: <the next queued array> }`.
 */
function mockRecordingDb(rowSets: unknown[][]) {
  const calls: { sql: string; params: unknown[] }[] = [];
  let i = 0;

  vi.mocked(withClient).mockImplementation(async (_env: any, fn: any) =>
    fn({
      query: vi.fn().mockImplementation(async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        return { rows: rowSets[i++] ?? [], rowCount: 1 };
      }),
    }),
  );

  return calls;
}

describe("client_ref on createLink", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(generateShortCode).mockReturnValue("abc1234");
    mockCacheDefaults();
  });

  it("persists and returns client_ref when supplied", async () => {
    const calls = mockRecordingDb([
      [{ configured: "3", stock: "0" }],
      [
        {
          id: "link-uuid",
          short_code: "abc1234",
          original_url: "https://example.com",
          title: null,
          client_ref: "ACME-0042",
          created_at: "2026-01-01T00:00:00Z",
        },
      ],
      [{ short_code: "abc1234" }], // registry claim
    ]);

    const { c, jsonFn } = mockContext({
      body: { original_url: "https://example.com", client_ref: "ACME-0042" },
    });

    await createLink(c as any);

    // The column is written on the INSERT, not applied afterwards
    const insert = calls.find((q) => /INSERT INTO/.test(q.sql))!;
    expect(insert.sql).toMatch(/client_ref/);
    expect(insert.params).toContain("ACME-0042");

    expect(jsonFn).toHaveBeenCalledWith(
      expect.objectContaining({ client_ref: "ACME-0042" }),
      201,
    );
  });

  it("succeeds with client_ref absent and returns null (backward compatibility)", async () => {
    const calls = mockRecordingDb([
      [{ configured: "3", stock: "0" }],
      [
        {
          id: "link-uuid",
          short_code: "abc1234",
          original_url: "https://example.com",
          title: null,
          client_ref: null,
          created_at: "2026-01-01T00:00:00Z",
        },
      ],
      [{ short_code: "abc1234" }], // registry claim
    ]);

    const { c, jsonFn } = mockContext({
      body: { original_url: "https://example.com" },
    });

    await createLink(c as any);

    const insert = calls.find((q) => /INSERT INTO/.test(q.sql))!;
    expect(insert.params).toContain(null);

    expect(jsonFn).toHaveBeenCalledWith(
      expect.objectContaining({ client_ref: null }),
      201,
    );
  });

  it("rejects a non-string client_ref with a 400 ValidationError", async () => {
    const { c } = mockContext({
      body: { original_url: "https://example.com", client_ref: 42 },
    });

    await expect(createLink(c as any)).rejects.toThrow(ValidationError);
    // Rejected before the DB is touched
    expect(withClient).not.toHaveBeenCalled();
  });

  it("rejects a client_ref longer than the cap with a 400 ValidationError", async () => {
    const { c } = mockContext({
      body: { original_url: "https://example.com", client_ref: "x".repeat(201) },
    });

    await expect(createLink(c as any)).rejects.toThrow(ValidationError);
    expect(withClient).not.toHaveBeenCalled();
  });
});

describe("client_ref on updateLink", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(generateShortCode).mockReturnValue("abc1234");
    mockCacheDefaults();
  });

  it("updates client_ref on an existing link via the existing PATCH path", async () => {
    const calls = mockRecordingDb([
      [{ short_code: "abc1234", is_active: true }],
    ]);

    const { c, jsonFn } = mockContext({
      params: { id: "link-uuid" },
      body: { client_ref: "ACME-0042" },
    });

    await updateLink(c as any);

    const update = calls.find((q) => /^UPDATE/i.test(q.sql.trim()))!;
    expect(update.sql).toMatch(/client_ref\s*=/);
    expect(update.params).toContain("ACME-0042");

    expect(jsonFn).toHaveBeenCalledWith({ ok: true });
  });

  it("rejects a non-string client_ref with a 400 ValidationError", async () => {
    const { c } = mockContext({
      params: { id: "link-uuid" },
      body: { client_ref: { id: 1 } },
    });

    await expect(updateLink(c as any)).rejects.toThrow(ValidationError);
    expect(withClient).not.toHaveBeenCalled();
  });

  it("clears client_ref when sent as null (the dashboard's unset path)", async () => {
    const calls = mockRecordingDb([
      [{ short_code: "abc1234", is_active: true }],
    ]);

    const { c, jsonFn } = mockContext({
      params: { id: "link-uuid" },
      body: { client_ref: null },
    });

    await updateLink(c as any);

    const update = calls.find((q) => /^UPDATE/i.test(q.sql.trim()))!;
    // NULL is inlined, not bound — so it must not shift the WHERE id placeholder
    expect(update.sql).toMatch(/client_ref = NULL/);
    expect(update.sql).toMatch(/WHERE id = \$1\b/);
    expect(update.params).toEqual(["link-uuid"]);

    expect(jsonFn).toHaveBeenCalledWith({ ok: true });
  });

  it("still supports the pre-existing is_active and title fields", async () => {
    const calls = mockRecordingDb([
      [{ short_code: "abc1234", is_active: false }],
    ]);

    const { c, jsonFn } = mockContext({
      params: { id: "link-uuid" },
      body: { is_active: false, title: "Renamed" },
    });

    await updateLink(c as any);

    const update = calls.find((q) => /^UPDATE/i.test(q.sql.trim()))!;
    expect(update.sql).toMatch(/is_active\s*=/);
    expect(update.sql).toMatch(/title\s*=/);
    expect(update.sql).not.toMatch(/client_ref\s*=/);

    expect(jsonFn).toHaveBeenCalledWith({ ok: true });
  });
});

describe("client_ref in listLinks", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns client_ref so the dashboard can render it", async () => {
    const calls = mockRecordingDb([
      [
        {
          id: "link-uuid",
          short_code: "abc1234",
          original_url: "https://example.com",
          title: null,
          client_ref: "ACME-0042",
          clicks_count: 5,
          is_active: true,
          expires_at: null,
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-02T00:00:00Z",
        },
      ],
    ]);

    const { c, jsonFn } = mockContext();

    await listLinks(c as any);

    // Selected in SQL, not assembled client-side
    expect(calls[0]!.sql).toMatch(/client_ref/);

    expect(jsonFn).toHaveBeenCalledWith([
      expect.objectContaining({ client_ref: "ACME-0042" }),
    ]);
  });

  it("returns client_ref null for links created before the column existed", async () => {
    mockRecordingDb([
      [
        {
          id: "old-link",
          short_code: "old1234",
          original_url: "https://example.com",
          title: "Legacy",
          client_ref: null,
          clicks_count: 0,
          is_active: true,
          expires_at: null,
          created_at: "2025-01-01T00:00:00Z",
          updated_at: "2025-01-01T00:00:00Z",
        },
      ],
    ]);

    const { c, jsonFn } = mockContext();

    await listLinks(c as any);

    expect(jsonFn).toHaveBeenCalledWith([
      expect.objectContaining({ client_ref: null }),
    ]);
  });
});

// ---------------------------------------------------------------------------
// Flat short URLs (T5.1)
//
// The link format is now `https://<domain>/<code>`. The tenant slug is gone
// from the URL, so a slug in `short_url` would advertise a dead route.
// ---------------------------------------------------------------------------

/** A created-link row as the INSERT ... RETURNING returns it. */
function createdLink(over: Record<string, unknown> = {}) {
  return {
    id: "link-uuid",
    short_code: "abc1234",
    original_url: "https://example.com",
    title: null,
    client_ref: null,
    created_at: "2026-01-01T00:00:00Z",
    ...over,
  };
}

describe("flat short_url output (T5.1)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(generateShortCode).mockReturnValue("abc1234");
    vi.mocked(setCachedUrl).mockResolvedValue(undefined);
    mockCacheDefaults();
  });

  it("createLink returns the flat short_url with no path prefix or tenant slug", async () => {
    mockRecordingDb([[{ configured: "2", stock: "0" }], [createdLink()], [{ short_code: "abc1234" }]]);

    const { c, jsonFn } = mockContext({ body: { original_url: "https://example.com" } });

    await createLink(c as any);

    expect(jsonFn).toHaveBeenCalledWith(
      expect.objectContaining({ short_url: "https://short.link/abc1234" }),
      201,
    );
  });

  it("listLinks returns a flat short_url for every row", async () => {
    mockRecordingDb([
      [createdLink({ id: "link-1", short_code: "aaa1111" }), createdLink({ id: "link-2", short_code: "bbb2222" })],
    ]);

    const { c, jsonFn } = mockContext();

    await listLinks(c as any);

    // The response is a bare array of links, so the per-row contract is asserted
    // positionally against the collection itself.
    expect(jsonFn).toHaveBeenCalledWith([
      expect.objectContaining({ short_url: "https://short.link/aaa1111" }),
      expect.objectContaining({ short_url: "https://short.link/bbb2222" }),
    ]);

    // The tenant slug is not part of the URL any more.
    const body = jsonFn.mock.calls[0]![0] as { short_url: string }[];
    for (const link of body) expect(link.short_url).not.toContain("/r/");
  });
});

// ---------------------------------------------------------------------------
// Registry maintenance (T4.1 — T4.3)
//
// Under flat links the registry IS the routing table. A link that exists in a
// tenant schema but not in `public.short_code_registry` is unreachable, and a
// registry row for a deleted link is a 404 that survives until the KV entry
// expires. So both directions are asserted here, not assumed.
// ---------------------------------------------------------------------------

describe("registry insert on createLink (T4.1)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(generateShortCode).mockReturnValue("abc1234");
    vi.mocked(setCachedUrl).mockResolvedValue(undefined);
    mockCacheDefaults();
  });

  it("inserts a registry row binding the short code to the tenant and link", async () => {
    const calls = mockRecordingDb([[{ configured: "0", stock: "0" }], [createdLink()], [{ short_code: "abc1234" }]]);

    const { c } = mockContext({ body: { original_url: "https://example.com" } });

    await createLink(c as any);

    const claim = calls.find((q) => /INSERT INTO public\.short_code_registry/i.test(q.sql))!;
    expect(claim).toBeDefined();
    expect(claim.params).toEqual(["abc1234", "tenant-uuid", "link-uuid"]);
  });

  it("claims the code with ON CONFLICT DO NOTHING so the primary key arbitrates", async () => {
    const calls = mockRecordingDb([[{ configured: "0", stock: "0" }], [createdLink()], [{ short_code: "abc1234" }]]);

    const { c } = mockContext({ body: { original_url: "https://example.com" } });

    await createLink(c as any);

    const claim = calls.find((q) => /INSERT INTO public\.short_code_registry/i.test(q.sql))!;
    expect(claim.sql).toMatch(/ON CONFLICT \(short_code\) DO NOTHING/i);
  });

  it("writes the registry row before reporting the link as created", async () => {
    // Ordering is the invariant: a 201 whose code is not yet resolvable is a
    // broken link handed to the user.
    const calls = mockRecordingDb([[{ configured: "0", stock: "0" }], [createdLink()], [{ short_code: "abc1234" }]]);

    const { c } = mockContext({ body: { original_url: "https://example.com" } });

    await createLink(c as any);

    const insertLink = calls.findIndex((q) => /INSERT INTO "tenant/i.test(q.sql));
    const insertRegistry = calls.findIndex((q) => /INSERT INTO public\.short_code_registry/i.test(q.sql));
    expect(insertLink).toBeGreaterThanOrEqual(0);
    expect(insertRegistry).toBeGreaterThan(insertLink);
  });

  it("warms the registry KV cache so the first redirect skips the join", async () => {
    mockRecordingDb([[{ configured: "0", stock: "0" }], [createdLink()], [{ short_code: "abc1234" }]]);

    const { c, waitUntilFn } = mockContext({ body: { original_url: "https://example.com" } });

    await createLink(c as any);

    await Promise.all(waitUntilFn.mock.calls.map((p: Promise<unknown>) => p));
    // Registry entry cache + short URL cache
    expect(waitUntilFn.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

describe("cross-tenant short-code collision (T4.1)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(setCachedUrl).mockResolvedValue(undefined);
    mockCacheDefaults();
  });

  it("rolls back its own link and retries when another tenant already claims the code", async () => {
    // The failure mode this covers: `{tenant}.links.short_code` is only UNIQUE
    // within a schema, so a second tenant CAN insert 'abc1234'. With no slug in
    // the URL the registry primary key is the only thing that can reject it, and
    // rejecting it must not leave an orphaned link behind.
    const calls = mockRecordingDb([
      [{ configured: "1", stock: "0" }], // active-link count
      [createdLink({ id: "link-1" })], // link INSERT succeeds
      [], // registry claim loses to tenant B
      [], // compensating DELETE of link-1
      [createdLink({ id: "link-2", short_code: "xyz5678" })], // retry link INSERT
      [{ short_code: "xyz5678" }], // registry claim wins
    ]);

    vi.mocked(generateShortCode)
      .mockReturnValueOnce("abc1234")
      .mockReturnValueOnce("xyz5678");

    const { c, jsonFn } = mockContext({ body: { original_url: "https://example.com" } });

    await createLink(c as any);

    expect(jsonFn).toHaveBeenCalledWith(
      expect.objectContaining({ id: "link-2", short_code: "xyz5678" }),
      201,
    );

    // The orphaned row was removed rather than left pointing nowhere.
    const compensating = calls.find((q) => /DELETE FROM "tenant/i.test(q.sql))!;
    expect(compensating).toBeDefined();
    expect(compensating.params).toEqual(["link-1"]);
  });

  it("fails after exhausting retries when every code is globally taken", async () => {
    mockRecordingDb([
      [{ configured: "1", stock: "0" }],
      [createdLink({ id: "link-1" })], [], [],
      [createdLink({ id: "link-2" })], [], [],
      [createdLink({ id: "link-3" })], [], [],
    ]);

    vi.mocked(generateShortCode)
      .mockReturnValueOnce("aaa1111")
      .mockReturnValueOnce("bbb2222")
      .mockReturnValueOnce("ccc3333");

    const { c } = mockContext({ body: { original_url: "https://example.com" } });

    await expect(createLink(c as any)).rejects.toThrow("link_creation_failed");
  });
});

describe("registry removal on deleteLink (T4.2, T4.3)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockCacheDefaults();
  });

  it("deletes the registry row for the deleted link", async () => {
    const calls = mockRecordingDb([[{ short_code: "abc1234" }], []]);

    const { c } = mockContext({ params: { id: "link-uuid" } });

    await deleteLink(c as any);

    const removal = calls.find((q) => /DELETE FROM public\.short_code_registry/i.test(q.sql))!;
    expect(removal).toBeDefined();
    expect(removal.params).toEqual(["abc1234"]);
  });

  it("invalidates both the registry and the short URL KV entries", async () => {
    mockRecordingDb([[{ short_code: "abc1234" }], []]);

    const { c, waitUntilFn } = mockContext({ params: { id: "link-uuid" } });

    await deleteLink(c as any);

    await Promise.all(waitUntilFn.mock.calls.map((p: Promise<unknown>) => p));

    expect(invalidateCachedRegistryEntry).toHaveBeenCalledWith(expect.anything(), "abc1234");
    expect(invalidateCachedUrl).toHaveBeenCalledWith(expect.anything(), "acme", "abc1234");
  });

  it("still invalidates the caches when the registry delete fails", async () => {
    // The link row is already gone by this point. A registry-delete failure
    // leaves a row that resolves to a 404 — the correct outcome — so it must
    // not turn a successful delete into a 500, and the short-URL entry still
    // has to be dropped or the deleted destination keeps being served.
    vi.mocked(withClient)
      .mockImplementationOnce(async (_env: any, fn: any) =>
        fn({ query: vi.fn().mockResolvedValueOnce({ rows: [{ short_code: "abc1234" }], rowCount: 1 }) }),
      )
      .mockImplementationOnce(async () => {
        throw new Error("registry unavailable");
      });

    const { c, jsonFn, waitUntilFn } = mockContext({ params: { id: "link-uuid" } });

    await deleteLink(c as any);

    expect(jsonFn).toHaveBeenCalledWith({ ok: true });

    await Promise.all(waitUntilFn.mock.calls.map((p: Promise<unknown>) => p));
    expect(invalidateCachedRegistryEntry).toHaveBeenCalledWith(expect.anything(), "abc1234");
    expect(invalidateCachedUrl).toHaveBeenCalledWith(expect.anything(), "acme", "abc1234");
  });

  it("does not touch the registry when no link matched", async () => {
    const calls = mockRecordingDb([[]]);

    const { c, waitUntilFn } = mockContext({ params: { id: "missing-link" } });

    await expect(deleteLink(c as any)).rejects.toThrow("not found");

    expect(calls.some((q) => /short_code_registry/i.test(q.sql))).toBe(false);
    expect(invalidateCachedRegistryEntry).not.toHaveBeenCalled();
    expect(waitUntilFn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// T3.2 — CALLER-SUPPLIED SLUG
//
// THE REQUIREMENT THAT DRIVES THIS ENTIRE BLOCK:
//
// One NFC tag or QR sticker per physical location, PRE-PRINTED, living in the
// world for months. The URL on a printed sticker cannot change afterwards
// without re-printing every sticker.
//
// So for a caller-supplied slug there is exactly one acceptable outcome when
// the slug is free — create it under that literal string — and exactly one
// acceptable outcome when it is taken — say so. Silently substituting a
// different code is the one thing that must never happen: it would produce
// stickers reading `.../cafe-central` that resolve to something else entirely,
// with no way to fix them later.
//
// The generated-code retry loop exists for the opposite case. There the user
// did not choose the code, so a second draw is free. Both behaviours coexist,
// and the guard below is what keeps them from bleeding into each other.
// ---------------------------------------------------------------------------

describe("caller-supplied slug (T3.2)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(generateShortCode).mockReturnValue("abc1234");
    mockCacheDefaults();
  });

  it("persists a free caller-supplied slug unchanged", async () => {
    const calls = mockRecordingDb([
      [{ configured: "0", stock: "0" }],
      [createdLink({ id: "link-uuid", short_code: "cafe-central" })],
      [{ short_code: "cafe-central" }],
    ]);

    const { c, jsonFn } = mockContext({
      body: { original_url: "https://example.com", slug: "cafe-central" },
    });

    await createLink(c as any);

    // The literal string reaches the INSERT and comes back out — not normalised,
    // not case-folded, not trimmed.
    const insert = calls.find((q) => /INSERT INTO "tenant/i.test(q.sql))!;
    expect(insert.params[1]).toBe("cafe-central");

    const claim = calls.find((q) => /INSERT INTO public\.short_code_registry/i.test(q.sql))!;
    expect(claim.params[0]).toBe("cafe-central");

    expect(jsonFn).toHaveBeenCalledWith(
      expect.objectContaining({
        short_code: "cafe-central",
        short_url: "https://short.link/cafe-central",
      }),
      201,
    );
  });

  /**
   * THE DECISIVE GUARD.
   *
   * A test that only checks the happy path passes while the system still
   * silently substitutes a random code — which is precisely the defect that
   * destroys printed tags. This asserts the two halves of the contract
   * together: a 409, and NO second code offered in its place.
   */
  it("returns 409 and creates NOTHING when the supplied slug is already taken", async () => {
    const calls = mockRecordingDb([
      [{ configured: "0", stock: "0" }], // active-link count — well under the cap
      [], // link INSERT → this tenant already uses the code
    ]);

    const { c } = mockContext({
      body: { original_url: "https://example.com", slug: "cafe-central" },
    });

    await expect(createLink(c as any)).rejects.toMatchObject({
      name: "ConflictError",
      status: 409,
    });

    // Nothing was created, and — the half that actually protects a printed tag
    // — the code generator was never consulted, so there is no substitute ready
    // to be returned by accident.
    expect(generateShortCode).not.toHaveBeenCalled();
    expect(calls.some((q) => /^INSERT/i.test(q.sql.trim()) && /short_code_registry/i.test(q.sql))).toBe(false);
    expect(calls.filter((q) => /^INSERT INTO "tenant/i.test(q.sql)).length).toBe(1);
  });

  it("returns 409 when another tenant already claims the slug globally", async () => {
    // The registry primary key is the constraint that can reject a code this
    // tenant does not itself hold — `short_code` is only UNIQUE per schema.
    const calls = mockRecordingDb([
      [{ configured: "0", stock: "0" }],
      [createdLink({ id: "link-1", short_code: "cafe-central" })],
      [], // registry claim loses to tenant B
    ]);

    const { c } = mockContext({
      body: { original_url: "https://example.com", slug: "cafe-central" },
    });

    await expect(createLink(c as any)).rejects.toMatchObject({ status: 409 });

    // The link row written before the losing claim must be rolled back, exactly
    // as the generated-code path does. Leaving it would be an orphan consuming a
    // quota slot for a link that was reported as never created.
    const compensating = calls.find((q) => /DELETE FROM "tenant/i.test(q.sql))!;
    expect(compensating).toBeDefined();
    expect(compensating.params).toEqual(["link-1"]);

    expect(generateShortCode).not.toHaveBeenCalled();
  });

  it("makes exactly ONE insert attempt for a supplied slug — the retry loop is skipped", async () => {
    // The mechanism behind D1, stated structurally rather than inferred from
    // the 409: the attempt budget is 1 when the caller named the code, so there
    // is no second draw sitting there ready to be substituted.
    const calls = mockRecordingDb([
      [{ configured: "0", stock: "0" }],
      [], // collide
    ]);

    const { c } = mockContext({
      body: { original_url: "https://example.com", slug: "cafe-central" },
    });

    await expect(createLink(c as any)).rejects.toMatchObject({ status: 409 });

    const linkInserts = calls.filter((q) => /^INSERT INTO "tenant/i.test(q.sql));
    expect(linkInserts).toHaveLength(1);
    // A generated path would have drawn MAX_RETRIES codes before giving up.
    expect(generateShortCode).not.toHaveBeenCalled();
  });

  it("still retries a GENERATED code — the two paths must not be confused", async () => {
    // The counterpart guard. If "skip the retry loop" were implemented as
    // "remove the retry loop", this test fails and the generated path silently
    // degrades to one shot with a random code.
    let callCount = 0;
    vi.mocked(withClient).mockImplementation(async (_env: any, fn: any) => {
      callCount++;
      if (callCount === 1) {
        return fn({ query: vi.fn().mockResolvedValueOnce({ rows: [{ configured: "0", stock: "0" }], rowCount: 1 }) });
      }
      if (callCount === 2) {
        return fn({ query: vi.fn().mockResolvedValueOnce({ rows: [], rowCount: 0 }) });
      }
      return fn({
        query: vi.fn()
          .mockResolvedValueOnce({ rows: [createdLink({ id: "link-2", short_code: "xyz5678" })], rowCount: 1 })
          .mockResolvedValueOnce({ rows: [{ short_code: "xyz5678" }], rowCount: 1 }),
      });
    });

    vi.mocked(generateShortCode)
      .mockReturnValueOnce("aaa1111")
      .mockReturnValueOnce("xyz5678");

    const { c, jsonFn } = mockContext({ body: { original_url: "https://example.com" } });

    await createLink(c as any);

    expect(jsonFn).toHaveBeenCalledWith(
      expect.objectContaining({ short_code: "xyz5678" }),
      201,
    );
    expect(callCount).toBe(3); // COUNT + 2 insert attempts
  });

  it("rejects a reserved slug with a 400 naming the route, before touching the DB", async () => {
    // D2: a reserved slug is an unreachable link, not an unlucky draw. Rejected
    // up front so no registry row is consumed and the user is told at creation
    // time, while the stickers are still unmade.
    const { c } = mockContext({
      body: { original_url: "https://example.com", slug: "dashboard" },
    });

    await expect(createLink(c as any)).rejects.toMatchObject({
      name: "ValidationError",
      status: 400,
      message: expect.stringContaining("dashboard"),
    });
    expect(withClient).not.toHaveBeenCalled();
  });

  it("rejects a malformed slug with a 400, before touching the DB", async () => {
    for (const bad of ["ab", "a".repeat(33), "cafe/central", "-cafe", "cafe-", "cafe central"]) {
      const { c } = mockContext({
        body: { original_url: "https://example.com", slug: bad },
      });
      await expect(createLink(c as any)).rejects.toMatchObject({
        name: "ValidationError",
        status: 400,
      });
    }
    expect(withClient).not.toHaveBeenCalled();
  });

  it("rejects a non-string slug with a 400 rather than coercing it", async () => {
    const { c } = mockContext({
      body: { original_url: "https://example.com", slug: 12345 },
    });

    await expect(createLink(c as any)).rejects.toMatchObject({ status: 400 });
    expect(withClient).not.toHaveBeenCalled();
  });

  it("treats an explicitly empty slug as absent, not as an invalid one", async () => {
    // The dashboard form sends `slug: ""` when the field is left blank. Treating
    // that as a validation failure would make the optional field mandatory.
    mockRecordingDb([[{ configured: "0", stock: "0" }], [createdLink()], [{ short_code: "abc1234" }]]);

    const { c, jsonFn } = mockContext({
      body: { original_url: "https://example.com", slug: "" },
    });

    await createLink(c as any);

    expect(jsonFn).toHaveBeenCalledWith(
      expect.objectContaining({ short_code: "abc1234" }),
      201,
    );
  });

  it("warm-warms nothing special: a supplied slug still warms both KV caches", async () => {
    mockRecordingDb([
      [{ configured: "0", stock: "0" }],
      [createdLink({ short_code: "cafe-central" })],
      [{ short_code: "cafe-central" }],
    ]);

    const { c, waitUntilFn } = mockContext({
      body: { original_url: "https://example.com", slug: "cafe-central" },
    });

    await createLink(c as any);
    await Promise.all(waitUntilFn.mock.calls.map((p: Promise<unknown>) => p));

    // A tag's first scan must not hit a cold cache; the supplied path has no
    // excuse for skipping the warm-up the generated path performs.
    expect(setCachedRegistryEntry).toHaveBeenCalledWith(
      expect.anything(),
      "cafe-central",
      expect.objectContaining({ linkId: "link-uuid" }),
    );
  });
});

// ---------------------------------------------------------------------------
// T3.1 — the active-link cap is CONFIGURATION, not a hardcoded free-tier number
//
// `MAX_ACTIVE_LINKS = 30` was written for a free tier and blocks one link per
// store outright: a 40-location chain cannot onboard. The guard itself is
// kept — a runaway-creation backstop has value — but the number becomes
// something an operator can set, with a named default that is not 30.
// ---------------------------------------------------------------------------

describe("configurable active-link cap (T3.1)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(generateShortCode).mockReturnValue("abc1234");
    mockCacheDefaults();
  });

  it("honours the cap when the environment variable is set", async () => {
    vi.mocked(withClient).mockImplementation(async (_env: any, fn: any) =>
      fn({ query: vi.fn().mockResolvedValueOnce({ rows: [{ configured: "7", stock: "0" }], rowCount: 1 }) }),
    );

    const { c, jsonFn } = mockContext({
      env: { MAX_ACTIVE_LINKS: "7" },
      body: { original_url: "https://example.com" },
    });

    await expect(createLink(c as any)).rejects.toMatchObject({ status: 429 });
    expect(jsonFn).not.toHaveBeenCalled();
  });

  it("allows creation below a configured cap", async () => {
    mockRecordingDb([[{ configured: "6", stock: "0" }], [createdLink()], [{ short_code: "abc1234" }]]);

    const { c, jsonFn } = mockContext({
      env: { MAX_ACTIVE_LINKS: "7" },
      body: { original_url: "https://example.com" },
    });

    await createLink(c as any);

    expect(jsonFn).toHaveBeenCalledWith(expect.any(Object), 201);
  });

  it("falls back to a named default when the variable is unset, and that default is NOT 30", async () => {
    // 30 is the value this task exists to retire. Pinning the default by
    // asserting it is greater than 30 keeps the old number from creeping back
    // in, without hardcoding a second arbitrary figure the test would have to
    // be edited alongside.
    expect(DEFAULT_MAX_ACTIVE_LINKS).toBeGreaterThan(30);

    mockRecordingDb([[{ configured: "30", stock: "0" }], [createdLink()], [{ short_code: "abc1234" }]]);

    const { c, jsonFn } = mockContext({ body: { original_url: "https://example.com" } });

    // 30 links used, no env var set: the create must SUCCEED.
    await createLink(c as any);

    expect(jsonFn).toHaveBeenCalledWith(expect.any(Object), 201);
  });

  it("still rejects at the default cap when it is genuinely reached", async () => {
    vi.mocked(withClient).mockImplementation(async (_env: any, fn: any) =>
      fn({
        query: vi.fn().mockResolvedValueOnce({
          rows: [{ configured: String(DEFAULT_MAX_ACTIVE_LINKS), stock: "0" }],
          rowCount: 1,
        }),
      }),
    );

    const { c } = mockContext({ body: { original_url: "https://example.com" } });

    await expect(createLink(c as any)).rejects.toMatchObject({ status: 429 });
  });

  it("ignores a non-numeric or non-positive env value rather than locking every tenant out", async () => {
    // A typo in a wrangler var must not read as 0 and reject every creation.
    for (const bad of ["", "many", "-5", "0", "12abc"]) {
      mockRecordingDb([[{ configured: "30", stock: "0" }], [createdLink()], [{ short_code: "abc1234" }]]);
      const { c, jsonFn } = mockContext({
        env: { MAX_ACTIVE_LINKS: bad },
        body: { original_url: "https://example.com" },
      });
      await createLink(c as any);
      expect(jsonFn).toHaveBeenCalledWith(expect.any(Object), 201);
    }
  });

  it("reports the CONFIGURED cap in the limit message, not a hardcoded number", async () => {
    vi.mocked(withClient).mockImplementation(async (_env: any, fn: any) =>
      fn({ query: vi.fn().mockResolvedValueOnce({ rows: [{ configured: "7", stock: "0" }], rowCount: 1 }) }),
    );

    const { c } = mockContext({
      env: { MAX_ACTIVE_LINKS: "7" },
      body: { original_url: "https://example.com" },
    });

    await expect(createLink(c as any)).rejects.toThrow(/7/);
    // And it does not report the default while enforcing the configured value.
    await expect(createLink(c as any)).rejects.not.toThrow(
      new RegExp(String(DEFAULT_MAX_ACTIVE_LINKS)),
    );
  });
});

// ---------------------------------------------------------------------------
// T3.2 — a slug can NEVER be changed after creation
//
// Not "not implemented yet". Not "not exposed in the UI". A printed tag's URL
// is immutable by definition: renaming a link breaks every sticker already in
// the world, and there is no way to recall them. updateLink therefore REJECTS
// the field rather than ignoring it, because a silently-ignored field leaves
// the caller believing a rename succeeded.
// ---------------------------------------------------------------------------

describe("updateLink cannot change a slug", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockCacheDefaults();
  });

  it("rejects a PATCH body carrying slug", async () => {
    const { c } = mockContext({
      params: { id: "link-uuid" },
      body: { slug: "renamed-tag" },
    });

    await expect(updateLink(c as any)).rejects.toMatchObject({
      name: "ValidationError",
      status: 400,
    });
    expect(withClient).not.toHaveBeenCalled();
  });

  it("rejects slug even when combined with fields it does accept", async () => {
    // A caller renaming a tag while also toggling it must get the same refusal;
    // letting the toggle through would half-apply a request the caller believes
    // was rejected.
    const { c } = mockContext({
      params: { id: "link-uuid" },
      body: { slug: "renamed-tag", is_active: false },
    });

    await expect(updateLink(c as any)).rejects.toMatchObject({ status: 400 });
    expect(withClient).not.toHaveBeenCalled();
  });

  it("never writes short_code, whatever the body contains", async () => {
    const calls = mockRecordingDb([[{ short_code: "abc1234", is_active: true }]]);

    await updateLink(
      mockContext({ params: { id: "link-uuid" }, body: { title: "Renamed" } }).c as any,
    );

    const update = calls.find((q) => /^UPDATE/i.test(q.sql.trim()))!;
    expect(update.sql).not.toMatch(/short_code\s*=/);
  });

  it("still accepts the fields it always did", async () => {
    mockRecordingDb([[{ short_code: "abc1234", is_active: true }]]);

    const { c, jsonFn } = mockContext({
      params: { id: "link-uuid" },
      body: { is_active: false, title: "Renamed", client_ref: "ACME-0042" },
    });

    await updateLink(c as any);

    expect(jsonFn).toHaveBeenCalledWith({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// Loading a destination onto card stock (T3)
//
// The manufacturing flow depends on this working AFTER the sticker is printed:
// create N links, print the QRs, then load the real destinations. `short_code`
// stays immutable — it is what is on the sticker — and only the destination
// behind it is editable.
// ---------------------------------------------------------------------------

describe("original_url on updateLink", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(generateShortCode).mockReturnValue("abc1234");
    mockCacheDefaults();
  });

  it("loads a destination onto a link that has none", async () => {
    const calls = mockRecordingDb([
      [{ short_code: "abc1234", is_active: true }],
    ]);

    const { c, jsonFn } = mockContext({
      params: { id: "link-uuid" },
      body: { original_url: "https://g.page/ACME/review" },
    });

    await updateLink(c as any);

    const update = calls.find((q) => /^UPDATE/i.test(q.sql.trim()))!;
    expect(update.sql).toMatch(/original_url\s*=/);
    expect(update.params).toContain("https://g.page/ACME/review");
    expect(jsonFn).toHaveBeenCalledWith({ ok: true });
  });

  it("rejects a scheme-less destination, exactly as creation does", async () => {
    const { c } = mockContext({
      params: { id: "link-uuid" },
      body: { original_url: "g.page/ACME/review" },
    });

    // Creation refuses a scheme-less URL rather than assuming https, and the
    // open-redirect guard must not be weaker on the late path than the
    // original one. Card stock makes this path reachable at a moment the owner
    // did not choose, so a typo here is likelier, not less.
    await expect(updateLink(c as any)).rejects.toThrow(ValidationError);
    expect(withClient).not.toHaveBeenCalled();
  });

  it("clears a destination back to unconfigured with null", async () => {
    const calls = mockRecordingDb([
      [{ short_code: "abc1234", is_active: true }],
    ]);

    const { c, jsonFn } = mockContext({
      params: { id: "link-uuid" },
      body: { original_url: null },
    });

    await updateLink(c as any);

    const update = calls.find((q) => /^UPDATE/i.test(q.sql.trim()))!;
    // Inlined, so it must not consume a bind slot or shift the WHERE id.
    expect(update.sql).toMatch(/original_url = NULL/);
    expect(update.sql).toMatch(/WHERE id = \$1\b/);
    expect(update.params).toEqual(["link-uuid"]);
    expect(jsonFn).toHaveBeenCalledWith({ ok: true });
  });

  it("treats an empty string as clear, because the form posts a blank field", async () => {
    const calls = mockRecordingDb([
      [{ short_code: "abc1234", is_active: true }],
    ]);

    const { c } = mockContext({
      params: { id: "link-uuid" },
      body: { original_url: "" },
    });

    await updateLink(c as any);

    const update = calls.find((q) => /^UPDATE/i.test(q.sql.trim()))!;
    expect(update.sql).toMatch(/original_url = NULL/);
  });

  it("still rejects a destination that is present and unsafe", async () => {
    // A late-loaded destination goes through the same open-redirect guard as a
    // created one. Card stock makes this path reachable at a time the owner did
    // not choose, so the guard cannot be the weaker one.
    const { c } = mockContext({
      params: { id: "link-uuid" },
      body: { original_url: "javascript:alert(1)" },
    });

    await expect(updateLink(c as any)).rejects.toThrow(ValidationError);
    expect(withClient).not.toHaveBeenCalled();
  });

  it("rejects a wrong-typed destination rather than silently dropping it", async () => {
    const { c } = mockContext({
      params: { id: "link-uuid" },
      body: { original_url: 12345 },
    });

    await expect(updateLink(c as any)).rejects.toThrow(ValidationError);
    expect(withClient).not.toHaveBeenCalled();
  });

  it("STILL rejects a slug — immutability of the printed code is untouched", async () => {
    // The regression this feature invites: relaxing the destination and quietly
    // relaxing the code with it. The code is what is on the sticker.
    const { c } = mockContext({
      params: { id: "link-uuid" },
      body: { slug: "renamed" },
    });

    await expect(updateLink(c as any)).rejects.toThrow(ValidationError);
    expect(withClient).not.toHaveBeenCalled();
  });

  it("rejects a rename even when it rides alongside a destination load", async () => {
    const { c } = mockContext({
      params: { id: "link-uuid" },
      body: { slug: "renamed", original_url: "https://g.page/x" },
    });

    await expect(updateLink(c as any)).rejects.toThrow(ValidationError);
    // Half-applied is the shape to avoid: the destination must not land while
    // the rename is refused.
    expect(withClient).not.toHaveBeenCalled();
  });

  it("invalidates the redirect cache, or the sticker serves the old destination", async () => {
    // The cache stores the DESTINATION for 24h. Load a new one and skip this,
    // and the owner pastes the sticker, the customer scans, and gets the
    // previous target with no error anywhere.
    mockRecordingDb([[{ short_code: "abc1234", is_active: true }]]);

    const { c, waitUntilFn } = mockContext({
      params: { id: "link-uuid" },
      body: { original_url: "https://g.page/new" },
    });

    await updateLink(c as any);

    expect(invalidateCachedUrl).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      "abc1234",
    );
    await Promise.all(waitUntilFn.mock.calls.map((p: any) => p));
  });

  it("loads a destination and a client_ref together, as the dashboard does", async () => {
    const calls = mockRecordingDb([
      [{ short_code: "abc1234", is_active: true }],
    ]);

    const { c } = mockContext({
      params: { id: "link-uuid" },
      body: { original_url: "https://g.page/x", client_ref: "ACME-1" },
    });

    await updateLink(c as any);

    const update = calls.find((q) => /^UPDATE/i.test(q.sql.trim()))!;
    expect(update.sql).toMatch(/original_url\s*=/);
    expect(update.sql).toMatch(/client_ref\s*=/);
    // Order follows the SET clause, not the request body: client_ref is
    // pushed before original_url. Asserted exactly rather than with
    // toContain, because a positional bind list is what a future reordering
    // would silently break — the id must stay last, after both fields.
    expect(update.params).toEqual([
      "ACME-1",
      "https://g.page/x",
      "link-uuid",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Card stock has its own budget
//
// Card stock is created before it has a destination, which is the state the
// whole manufacturing flow depends on. These tests pin the consequence: stock
// must NOT consume the link budget, and it must still be bounded.
// ---------------------------------------------------------------------------
describe("card stock is bounded separately from the link budget", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(generateShortCode).mockReturnValue("abc1234");
    mockCacheDefaults();
  });

  it("counts configured links and stock as two distinct numbers", async () => {
    // One query, two FILTER counts. Reading them as one number is what caused
    // card stock to eat the link budget in the first place.
    mockRecordingDb([
      [{ configured: "7", stock: "450" }],
      [createdLink()],
      [{ short_code: "abc1234" }],
    ]);

    await createLink(mockContext({ body: { original_url: "https://example.com" } }).c as any);

    const countSql = vi.mocked(withClient).mock.results.length;
    expect(countSql).toBeGreaterThan(0);
  });

  it("does not charge card stock against the link budget", async () => {
    // 450 cards exist and the configured count is 7. Creating a 51st
    // CONFIGURED link must succeed: the 450 cards are not links anyone is
    // being sent to, and charging for them meant an owner with a hundred
    // working stickers could not manufacture fifty more.
    mockRecordingDb([
      [{ configured: "7", stock: "450" }],
      [createdLink()],
      [{ short_code: "abc1234" }],
    ]);

    const { c, jsonFn } = mockContext({
      env: { MAX_ACTIVE_LINKS: "50" },
      body: { original_url: "https://example.com" },
    });

    await createLink(c as any);
    expect(jsonFn).toHaveBeenCalledWith(expect.any(Object), 201);
  });

  it("still bounds card stock", async () => {
    // Not unbounded. An unbounded creation path is how a loop bug becomes an
    // outage, and a stolen token should not be able to fill a table for free.
    // AT the cap, not one below it. `>=` is the comparison, so a row of 2000
    // against a cap of 2000 is refused and 1999 is not.
    mockRecordingDb([[{ configured: "0", stock: "2000" }]]);

    const { c } = mockContext({
      env: { MAX_CARD_STOCK: "2000" },
      body: { client_ref: "table-14" },
    });

    await expect(createLink(c as any)).rejects.toMatchObject({ status: 429 });
  });

  it("lets a card through below the stock bound", async () => {
    mockRecordingDb([
      [{ configured: "0", stock: "1998" }],
      [createdLink()],
      [{ short_code: "abc1234" }],
    ]);

    const { c, jsonFn } = mockContext({
      env: { MAX_CARD_STOCK: "2000" },
      body: { client_ref: "table-14" },
    });

    await createLink(c as any);
    expect(jsonFn).toHaveBeenCalledWith(expect.any(Object), 201);
  });

  it("says WHICH budget was hit, because they are different numbers", async () => {
    // "Link limit reached" from a card-manufacturing run sends an operator
    // looking at the wrong configuration value. The message must name both.
    mockRecordingDb([[{ configured: "0", stock: "2000" }]]);

    const { c } = mockContext({
      env: { MAX_ACTIVE_LINKS: "50", MAX_CARD_STOCK: "2000" },
      body: { client_ref: "table-14" },
    });

    // One invocation, one rejection, two assertions. Awaiting twice would consume
    // the single mocked row and the second would fail for the wrong reason.
    await expect(createLink(c as any)).rejects.toThrow(
      /Card stock limit reached.*separate from the link limit of 50/s,
    );
  });

  it("keeps the configured-link message honest about what it counts", async () => {
    mockRecordingDb([[{ configured: "50", stock: "900" }]]);

    const { c } = mockContext({
      env: { MAX_ACTIVE_LINKS: "50" },
      body: { original_url: "https://example.com" },
    });

    await expect(createLink(c as any)).rejects.toThrow(/with a destination/);
  });

  it("gates BOTH buckets on is_active, so disabling a card frees budget", async () => {
    // An operator over-stocked with cards reaches for the toggle and expects it
    // to work. It does, because `is_active` appears in both FILTER arms rather
    // than being applied to the row as a whole.
    const calls = mockRecordingDb([
      [{ configured: "0", stock: "0" }],
      [createdLink()],
      [{ short_code: "abc1234" }],
    ]);

    await createLink(mockContext({ body: { client_ref: "table-14" } }).c as any);

    const countSql = calls.map((c) => c.sql).find((sql) => sql.includes("FILTER"));
    expect(countSql).toBeDefined();
    // Twice: once per bucket. One arm alone would leave a bucket unbounded by
    // the toggle.
    expect(countSql!.match(/is_active = true/g)).toHaveLength(2);
  });

  it("falls back to the documented default on a malformed MAX_CARD_STOCK", async () => {
    // Same discipline as MAX_ACTIVE_LINKS: a typo must never read as 0 and lock
    // a tenant out of manufacturing.
    for (const bad of ["", "many", "-5", "0", "12abc"]) {
      vi.resetAllMocks();
      vi.mocked(generateShortCode).mockReturnValue("abc1234");
      mockCacheDefaults();

      mockRecordingDb([
        [{ configured: "0", stock: "0" }],
        [createdLink()],
        [{ short_code: "abc1234" }],
      ]);

      const { c, jsonFn } = mockContext({
        env: { MAX_CARD_STOCK: bad },
        body: { client_ref: "table-14" },
      });

      await createLink(c as any);
      expect(jsonFn).toHaveBeenCalledWith(expect.any(Object), 201);
    }
  });

  it("defaults card stock well above the link budget", async () => {
    // The relationship is the whole point: if the default were equal, the split
    // would be a refactor rather than a fix.
    expect(DEFAULT_MAX_CARD_STOCK).toBeGreaterThan(DEFAULT_MAX_ACTIVE_LINKS);
  });
});
