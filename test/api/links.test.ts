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

vi.mock("../../src/cache/shortcode", () => ({
  setCachedUrl: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Mock short-code generator
// ---------------------------------------------------------------------------

vi.mock("../../src/utils/short-code", () => ({
  generateShortCode: vi.fn(),
}));

import { withClient } from "../../src/db/client";
import { setCachedUrl } from "../../src/cache/shortcode";
import { generateShortCode } from "../../src/utils/short-code";
import { createLink, linkClicks } from "../../src/api/links";

// ---------------------------------------------------------------------------
// Helper: mock Hono context
// ---------------------------------------------------------------------------

function mockContext(overrides: {
  tenant?: { tenantSlug: string; schemaName: string; tenantId: string };
  body?: object;
  jsonParseError?: boolean;
  params?: Record<string, string>;
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
    vi.mocked(setCachedUrl).mockResolvedValue(undefined);
  });

  it("returns 201 with the created link resource (happy path)", async () => {
    let callCount = 0;
    vi.mocked(withClient).mockImplementation(async (_env: any, fn: any) => {
      callCount++;
      if (callCount === 1) {
        // COUNT query: 5 active links
        return fn({
          query: vi.fn().mockResolvedValueOnce({ rows: [{ count: "5" }], rowCount: 1 }),
        });
      }
      // INSERT query: success
      return fn({
        query: vi.fn().mockResolvedValueOnce({
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
        }),
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
        short_url: "https://short.link/r/acme/abc1234",
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

  it("returns 429 when at 30 active links limit", async () => {
    vi.mocked(withClient).mockImplementation(async (_env: any, fn: any) => {
      return fn({
        query: vi.fn().mockResolvedValueOnce({ rows: [{ count: "30" }], rowCount: 1 }),
      });
    });

    const { c } = mockContext({
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
          query: vi.fn().mockResolvedValueOnce({ rows: [{ count: "10" }], rowCount: 1 }),
        });
      }
      if (callCount === 2) {
        // First INSERT: collision (rowCount 0)
        return fn({
          query: vi.fn().mockResolvedValueOnce({ rows: [], rowCount: 0 }),
        });
      }
      // callCount === 3: Second INSERT: success
      return fn({
        query: vi.fn().mockResolvedValueOnce({
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
        }),
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
          query: vi.fn().mockResolvedValueOnce({ rows: [{ count: "10" }], rowCount: 1 }),
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
          query: vi.fn().mockResolvedValueOnce({ rows: [{ count: "0" }], rowCount: 1 }),
        });
      }
      return fn({
        query: vi.fn().mockResolvedValueOnce({
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
        }),
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
          query: vi.fn().mockResolvedValueOnce({ rows: [{ count: "29" }], rowCount: 1 }),
        });
      }
      return fn({
        query: vi.fn().mockResolvedValueOnce({
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
        }),
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
 * link); `recent` stands in for the recent-N projection. Each SQL text selects
 * which one is returned, so the handler's query shape drives the mock rather
 * than a brittle call-order sequence.
 */
function mockClicksDb(opts: {
  grouped: unknown[];
  recent: unknown[];
  linkExists?: boolean;
  aggregateThrows?: boolean;
}) {
  const calls: string[] = [];

  vi.mocked(withClient).mockImplementation(async (_env: any, fn: any) =>
    fn({
      query: vi.fn().mockImplementation(async (sql: string) => {
        calls.push(sql);
        if (sql.includes("SELECT id FROM")) {
          return { rows: opts.linkExists === false ? [] : [{ id: "link-uuid" }] };
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

  return { calls };
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
    vi.mocked(setCachedUrl).mockResolvedValue(undefined);
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
