import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// T3.3 — POST /api/links/batch
//
// THE USE CASE: onboarding a chain means many links in one request — one NFC tag
// or QR sticker per physical location, each pre-printed. A single bad row in a
// spreadsheet must NOT roll back the other nineteen. That is the entire point
// of batching for a CRM import: one typo in row 7 is not a reason to lose rows
// 1-6 and 8-20.
//
// So this endpoint reports PER ITEM. Each input gets its own status and either
// the created link or the error code that stopped it. Partial success is
// explicit, never silent, and never a rollback.
// ---------------------------------------------------------------------------

vi.mock("../../src/db/client", () => ({
  withClient: vi.fn(),
}));

vi.mock("../../src/cache/shortcode", () => ({
  setCachedUrl: vi.fn().mockResolvedValue(undefined),
  invalidateCachedUrl: vi.fn().mockResolvedValue(undefined),
  getCachedUrl: vi.fn().mockResolvedValue(null),
  getCachedRegistryEntry: vi.fn().mockResolvedValue(null),
  setCachedRegistryEntry: vi.fn().mockResolvedValue(undefined),
  invalidateCachedRegistryEntry: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/utils/short-code", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/utils/short-code")>();
  return { ...actual, generateShortCode: vi.fn() };
});

/**
 * Pass-through auth for the routing tests, so route WIRING is what is under
 * test rather than JWT verification.
 */
vi.mock("../../src/middleware/auth", () => ({
  auth: vi.fn().mockImplementation(async (c: any, next: any) => {
    c.set("user", { userId: "user-uuid", email: "dev@example.com" });
    await next();
  }),
}));

/**
 * Records whether the tenant middleware ran.
 *
 * The batch handler reads `c.get("tenant")` to qualify the links table. If the
 * middleware is missing from the chain that read is undefined and the handler
 * throws — which is a 500, not a wrong answer, but it is the observable
 * signature of a chain wired incorrectly.
 *
 * This spy exists so the routing test can assert the chain by BEHAVIOUR
 * (did it run?) rather than by counting array entries, which would pass even if
 * the wrong two middleware were registered.
 */
vi.mock("../../src/middleware/tenant", () => ({
  createTenantMembershipMiddleware: vi.fn(() =>
    vi.fn(async (c: any, next: any) => {
      (globalThis as any).__tenantMiddlewareRuns =
        ((globalThis as any).__tenantMiddlewareRuns ?? 0) + 1;
      c.set("tenant", {
        tenantSlug: "acme",
        schemaName: "tenant_a7f3",
        tenantId: "tenant-uuid",
        tenantSalt: "salt",
      });
      await next();
    }),
  ),
}));

import { withClient } from "../../src/db/client";
import { generateShortCode } from "../../src/utils/short-code";
import { setCachedUrl } from "../../src/cache/shortcode";
import { createLinksBatch, MAX_BATCH_SIZE } from "../../src/api/batch";
import { createApp } from "../../src/router";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockContext(overrides: { body?: unknown; jsonParseError?: boolean } = {}) {
  const waitUntilFn = vi.fn();
  const jsonFn = vi.fn().mockImplementation(
    (body: unknown, status: number) => new Response(JSON.stringify(body), { status }),
  );

  const c = {
    req: {
      json: overrides.jsonParseError
        ? vi.fn().mockRejectedValue(new Error("Invalid JSON"))
        : vi.fn().mockResolvedValue(overrides.body ?? {}),
      param: vi.fn().mockReturnValue(""),
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
    get: vi.fn().mockImplementation((key: string) => {
      if (key === "tenant") {
        return {
          tenantSlug: "acme",
          schemaName: "tenant_a7f3",
          tenantId: "tenant-uuid",
          tenantSalt: "salt",
        };
      }
      return undefined;
    }),
    executionCtx: { waitUntil: waitUntilFn },
  };

  return { c, jsonFn, waitUntilFn };
}

/**
 * Routes each statement by its SQL text rather than by call order.
 *
 * A batch issues a variable, interleaved number of queries per item, so an
 * ordered queue would make these tests depend on how many statements each item
 * happens to take. Matching on SQL is what lets an item collide, another be
 * rejected before the DB, and a third succeed — in one request.
 */
function mockBatchDb(opts: {
  activeCount?: number;
  /** original_url values whose link INSERT loses the per-tenant UNIQUE race. */
  perTenantCollisions?: string[];
  /** short_code values whose registry claim loses the global PRIMARY KEY. */
  takenCodes?: string[];
  /** location ids `SELECT id FROM public.locations` resolves as this tenant's. */
  ownedLocations?: string[];
  /** location ids the lookup returns nothing for — wrong tenant, or deleted. */
  unknownLocations?: string[];
} = {}) {
  const owned = new Set(opts.ownedLocations ?? []);
  const unknown = new Set(opts.unknownLocations ?? []);
  const perTenant = new Set(opts.perTenantCollisions ?? []);
  const taken = new Set(opts.takenCodes ?? []);
  const calls: { sql: string; params: unknown[] }[] = [];
  let seq = 0;

  vi.mocked(withClient).mockImplementation(async (_env: any, fn: any) =>
    fn({
      query: vi.fn().mockImplementation(async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });

        if (sql.includes("public.locations")) {
          const id = String(params[0]);
          if (unknown.has(id)) return { rows: [], rowCount: 0 };
          if (owned.has(id)) return { rows: [{ id }], rowCount: 1 };
          // Unlisted ids resolve as absent, which is what an unconfigured
          // tenant's location table looks like.
          return { rows: [], rowCount: 0 };
        }

        if (sql.includes("SELECT COUNT")) {
          return { rows: [{ count: String(opts.activeCount ?? 0) }], rowCount: 1 };
        }

        if (sql.includes("INSERT INTO") && sql.includes("short_code_registry")) {
          const code = String(params[0]);
          if (taken.has(code)) return { rows: [], rowCount: 0 };
          return { rows: [{ short_code: code }], rowCount: 1 };
        }

        if (sql.includes("INSERT INTO") && sql.includes("links")) {
          const url = String(params[0]);
          const code = String(params[1]);
          if (perTenant.has(url)) return { rows: [], rowCount: 0 };
          const id = `link-${++seq}`;
          return {
            rows: [
              {
                id,
                short_code: code,
                // Card stock binds null here; String() would report "null" and
                // hide the very state these tests are about.
                original_url: params[0] ?? null,
                title: params[2] ?? null,
                client_ref: params[4] ?? null,
                is_gated: params[5] ?? false,
                location_id: params[6] ?? null,
                created_at: "2026-01-01T00:00:00Z",
              },
            ],
            rowCount: 1,
          };
        }

        if (sql.includes("DELETE FROM")) return { rows: [], rowCount: 0 };
        return { rows: [], rowCount: 0 };
      }),
    }),
  );

  return calls;
}

/** An item the happy path accepts. */
function item(over: Record<string, unknown> = {}) {
  return { original_url: "https://example.com", ...over };
}

// ---------------------------------------------------------------------------
// D4 — partial success
// ---------------------------------------------------------------------------

describe("batch creation reports per item (T3.3)", () => {
  beforeEach(() => {
    // clearAllMocks, NOT resetAllMocks.
    //
    // The routing tests below build the real app from the mocked auth and
    // tenant middleware. resetAllMocks strips implementations, so
    // createTenantMembershipMiddleware() would return undefined and every route
    // would register a chain containing `undefined` — the tests would then be
    // asserting on a broken app and "passing" for the wrong reason.
    vi.clearAllMocks();
    vi.mocked(generateShortCode).mockReturnValue("gen1234");
    (globalThis as any).__tenantMiddlewareRuns = 0;
  });

  it("creates a batch of valid items and reports one result per input", async () => {
    mockBatchDb();

    const { c, jsonFn } = mockContext({
      body: {
        links: [
          item({ original_url: "https://a.example" }),
          item({ original_url: "https://b.example" }),
          item({ original_url: "https://c.example" }),
        ],
      },
    });

    await createLinksBatch(c as any);

    const body = jsonFn.mock.calls[0]![0] as any;
    expect(body.results).toHaveLength(3);
    expect(body.created).toBe(3);
    expect(body.failed).toBe(0);
    expect(body.results.every((r: any) => r.status === 201 && r.link?.short_url)).toBe(true);
  });

  /**
   * THE DECISIVE GUARD.
   *
   * Row 2 carries a malformed URL. The other two must still be created, and the
   * response must NAME row 2 and its error code. A batch endpoint that wrapped
   * the whole thing in one try/catch would reject everything — which is exactly
   * the CRM-import failure this endpoint exists to prevent.
   */
  it("a batch with one invalid item still creates the valid ones, naming which failed", async () => {
    mockBatchDb();

    const { c, jsonFn } = mockContext({
      body: {
        links: [
          item({ original_url: "https://good-one.example", client_ref: "STORE-1" }),
          // No scheme at all — rejected by validateUrl before any SQL runs.
          item({ original_url: "not-a-url" }),
          item({ original_url: "https://good-two.example", client_ref: "STORE-2" }),
        ],
      },
    });

    await createLinksBatch(c as any);

    const body = jsonFn.mock.calls[0]![0] as any;

    // Partial success is EXPLICIT: two created, one failed.
    expect(body.created).toBe(2);
    expect(body.failed).toBe(1);
    expect(body.results).toHaveLength(3);

    // Positionally aligned with the input, so a caller can map result → row.
    expect(body.results[0]).toMatchObject({ index: 0, status: 201 });
    expect(body.results[2]).toMatchObject({ index: 2, status: 201 });

    const failed = body.results[1];
    expect(failed.index).toBe(1);
    expect(failed.status).toBe(400);
    expect(failed.link).toBeUndefined();
    // The error CODE, not just a message — an import script needs to branch on it.
    expect(typeof failed.code).toBe("string");
    expect(failed.code).toBeTruthy();
  });

  it("reports a reserved slug for one item without aborting its neighbours", async () => {
    mockBatchDb();

    const { c, jsonFn } = mockContext({
      body: {
        links: [
          item({ original_url: "https://a.example", slug: "store-a" }),
          item({ original_url: "https://b.example", slug: "dashboard" }),
          item({ original_url: "https://c.example", slug: "store-c" }),
        ],
      },
    });

    await createLinksBatch(c as any);

    const body = jsonFn.mock.calls[0]![0] as any;
    expect(body.created).toBe(2);
    expect(body.failed).toBe(1);
    expect(body.results[1].status).toBe(400);
    // The reserved route is named, so the operator can fix the spreadsheet.
    expect(body.results[1].error).toContain("dashboard");
  });

  it("reports a duplicate slug as 409 for that item only — never a substituted code", async () => {
    mockBatchDb({ takenCodes: ["store-b"] });

    const { c, jsonFn } = mockContext({
      body: {
        links: [
          item({ original_url: "https://a.example", slug: "store-a" }),
          item({ original_url: "https://b.example", slug: "store-b" }),
          item({ original_url: "https://c.example", slug: "store-c" }),
        ],
      },
    });

    await createLinksBatch(c as any);

    const body = jsonFn.mock.calls[0]![0] as any;
    expect(body.created).toBe(2);
    expect(body.results[1]).toMatchObject({ index: 1, status: 409 });
    expect(body.results[1].link).toBeUndefined();
  });

  it("isolates a database failure to the item that caused it", async () => {
    let seen = 0;
    vi.mocked(withClient).mockImplementation(async (_env: any, fn: any) =>
      fn({
        query: vi.fn().mockImplementation(async (sql: string, params: unknown[] = []) => {
          if (sql.includes("SELECT COUNT")) return { rows: [{ count: "0" }], rowCount: 1 };
          // Item 2's link INSERT hits a database error.
          if (sql.includes("INSERT INTO") && sql.includes("links")) {
            if (++seen === 2) throw new Error("connection reset");
            const code = String(params[1]);
            return {
              rows: [{
                id: `link-${seen}`,
                short_code: code,
                original_url: String(params[0]),
                title: null,
                client_ref: null,
                created_at: "2026-01-01T00:00:00Z",
              }],
              rowCount: 1,
            };
          }
          if (sql.includes("short_code_registry")) {
            const code = String(params[0]);
            return { rows: [{ short_code: code }], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        }),
      }),
    );

    const { c, jsonFn } = mockContext({
      body: {
        links: [
          item({ original_url: "https://a.example" }),
          item({ original_url: "https://b.example" }),
          item({ original_url: "https://c.example" }),
        ],
      },
    });

    await createLinksBatch(c as any);

    const body = jsonFn.mock.calls[0]![0] as any;
    // Items 1 and 3 still land. One row failing does not abort the import.
    expect(body.created).toBe(2);
    expect(body.results[1].status).toBeGreaterThanOrEqual(500);
  });

  it("returns a top-level 201 when everything succeeded and 207 when partially", async () => {
    mockBatchDb();
    const all = mockContext({
      body: { links: [item({ original_url: "https://a.example" })] },
    });
    await createLinksBatch(all.c as any);
    expect(all.jsonFn.mock.calls[0]![1]).toBe(201);

    mockBatchDb();
    const partial = mockContext({
      body: {
        links: [item({ original_url: "https://a.example" }), item({ original_url: "bad" })],
      },
    });
    await createLinksBatch(partial.c as any);

    // 207 is what tells an import script "some rows need attention" without it
    // having to diff the results array to discover it.
    expect(partial.jsonFn.mock.calls[0]![1]).toBe(207);
  });

  it("surfaces a non-object item rather than crashing the batch", async () => {
    mockBatchDb();

    const { c, jsonFn } = mockContext({
      body: { links: [item({ original_url: "https://a.example" }), "not-an-object"] },
    });

    await createLinksBatch(c as any);

    const body = jsonFn.mock.calls[0]![0] as any;
    expect(body.created).toBe(1);
    expect(body.results[1].status).toBe(400);
  });

  it("rejects a non-array payload outright", async () => {
    for (const bad of [{}, { links: "nope" }, { links: 42 }]) {
      const { c } = mockContext({ body: bad });
      await expect(createLinksBatch(c as any)).rejects.toMatchObject({ status: 400 });
    }
  });

  it("rejects an empty batch rather than returning a vacuous success", async () => {
    const { c } = mockContext({ body: { links: [] } });
    await expect(createLinksBatch(c as any)).rejects.toMatchObject({ status: 400 });
  });

  it("rejects a batch beyond the maximum size", async () => {
    const huge = Array.from({ length: MAX_BATCH_SIZE + 1 }, (_, i) =>
      item({ original_url: `https://x${i}.example` }),
    );
    const { c } = mockContext({ body: { links: huge } });
    await expect(createLinksBatch(c as any)).rejects.toMatchObject({ status: 400 });
  });

  it("rejects an unparseable body with a 400", async () => {
    const { c } = mockContext({ jsonParseError: true });
    await expect(createLinksBatch(c as any)).rejects.toMatchObject({ status: 400 });
  });
});

// ---------------------------------------------------------------------------
// T3.3 — route registration and the middleware chain
//
// Getting this chain wrong LEAKS TENANT DATA. The batch handler qualifies its
// queries against `c.get("tenant").schemaName`; a route registered without the
// tenant middleware does not merely read the wrong rows, it throws on an
// undefined context — and any future edit that made it tolerate that would read
// across tenants. So the chain is asserted, not assumed.
// ---------------------------------------------------------------------------

describe("POST /api/links/batch is registered on the tenant-scoped chain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(generateShortCode).mockReturnValue("gen1234");
    (globalThis as any).__tenantMiddlewareRuns = 0;
  });

  function appRoutes() {
    return createApp({} as any).routes;
  }

  it("registers the batch route", () => {
    const routes = appRoutes().filter((r) => r.path === "/api/links/batch");
    expect(routes.length).toBeGreaterThan(0);
    expect(routes.every((r) => r.method === "POST")).toBe(true);
  });

  it("carries the SAME number of middleware handlers as POST /api/links", () => {
    // Structural. Hono 4.13 records one `app.routes` entry PER HANDLER rather
    // than one entry holding the chain, so a route registered as
    // `post(path, auth, tenantMw, handler)` appears three times in that list.
    // That repetition is the chain made visible, and it is why the count can be
    // compared against the route this one must match: auth → tenant → handler is
    // three, and a route missing the tenant middleware is two.
    const app = createApp({} as any);
    const batchChain = app.routes.filter((r) => r.path === "/api/links/batch");
    const singleChain = app.routes.filter(
      (r) => r.path === "/api/links" && r.method === "POST",
    );

    expect(batchChain).toHaveLength(3);
    expect(batchChain).toHaveLength(singleChain.length);
  });

  it("runs auth and the tenant middleware on a real request through the app", async () => {
    // Behavioural, and the one that would catch a chain wired with the RIGHT
    // NUMBER of handlers but the wrong two. The counter only moves if
    // createTenantMembershipMiddleware's instance actually executed.
    //
    // `app.fetch(request, env, executionCtx)` rather than `app.request(path)`:
    // the latter binds an EMPTY env, so `c.env.SHORT_URL_DOMAIN` is undefined and
    // `c.executionCtx` is absent. That is not a flaw in the route — it is a
    // difference between a real Worker invocation and a bare router exercise,
    // and this test is claiming to be the former.
    mockBatchDb();

    const app = createApp({} as any);
    const req = new Request("https://short.link/api/links/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ links: [item({ original_url: "https://a.example" })] }),
    });

    const res = await app.fetch(
      req,
      { SHORT_URL_DOMAIN: "short.link" } as any,
      { waitUntil: () => {}, passThroughOnException: () => {} } as any,
    );

    expect((globalThis as any).__tenantMiddlewareRuns).toBeGreaterThan(0);
    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toMatchObject({ created: 1, failed: 0 });
  });

  it("serves the batch route without the short-code catch-all swallowing it", async () => {
    // `/:code` is registered last and matches any single segment. `/api/links/batch`
    // is two segments so it cannot collide — but the route must be registered
    // BEFORE the catch-all in reading order, or the table is misleading and a
    // future move could break it.
    const paths = appRoutes().map((r) => r.path);
    expect(paths.indexOf("/api/links/batch")).toBeGreaterThanOrEqual(0);
    expect(paths.indexOf("/api/links/batch")).toBeLessThan(paths.indexOf("/:code"));
  });
});
// ---------------------------------------------------------------------------
// Card stock: links created before their destination exists
//
// The manufacturing flow is a batch: the owner creates N links carrying no
// destination, the designer prints each short_code as a QR, and the real URL is
// loaded later. These tests pin the two halves of that promise — the batch
// succeeds without a destination, and it does NOT stop validating one.
// ---------------------------------------------------------------------------

describe("card stock (destination optional)", () => {
  it("creates a link with no destination at all", async () => {
    const calls = mockBatchDb();

    const { c, jsonFn } = mockContext({
      body: { links: [{ client_ref: "mesa-1" }] },
    });

    await createLinksBatch(c as any);

    const body = jsonFn.mock.calls[0]![0] as any;
    expect(body.created).toBe(1);
    expect(body.failed).toBe(0);
    expect(body.results[0].link.original_url).toBeNull();
    expect(body.results[0].link.short_code).toBeTruthy();
    expect(body.results[0].link.short_url).toContain(body.results[0].link.short_code);
  });

  it("creates N card-stock links in one batch", async () => {
    // Distinct codes, because two identical QRs on two cards is the failure
    // this whole feature exists to avoid. The suite-wide stub returns a
    // constant, so this overrides it for the one assertion that needs variety.
    let n = 0;
    vi.mocked(generateShortCode).mockImplementation(() => `code${++n}`);
    mockBatchDb();

    const { c, jsonFn } = mockContext({
      body: { links: Array.from({ length: 10 }, () => ({ client_ref: "pack" })) },
    });

    await createLinksBatch(c as any);

    const body = jsonFn.mock.calls[0]![0] as any;
    expect(body.created).toBe(10);
    expect(body.failed).toBe(0);

    // Every one must carry a distinct, PRINTABLE code — that is the whole point
    // of the batch. A duplicate here would put two identical QRs on two cards.
    const codes = body.results.map((r: any) => r.link.short_code);
    expect(new Set(codes).size).toBe(10);
  });

  it("mixes configured links and card stock in one batch", async () => {
    mockBatchDb();

    const { c, jsonFn } = mockContext({
      body: {
        links: [
          item({ original_url: "https://a.example" }),
          { client_ref: "pending" },
        ],
      },
    });

    await createLinksBatch(c as any);

    const body = jsonFn.mock.calls[0]![0] as any;
    expect(body.created).toBe(2);
    // Normalised on the way in, exactly as before this change.
    expect(body.results[0].link.original_url).toBe("https://a.example/");
    expect(body.results[1].link.original_url).toBeNull();
  });

  it("treats an empty original_url as absent, not as a relative URL", async () => {
    // The dashboard form posts "" for a blank required field. Reading that as a
    // URL would send validateUrl a relative path and reject a legitimate
    // card-stock request.
    mockBatchDb();

    const { c, jsonFn } = mockContext({
      body: { links: [{ original_url: "", client_ref: "blank" }] },
    });

    await createLinksBatch(c as any);

    const body = jsonFn.mock.calls[0]![0] as any;
    expect(body.created).toBe(1);
    expect(body.results[0].link.original_url).toBeNull();
  });

  it("still rejects a destination that is present and invalid", async () => {
    // Optional must never mean unchecked. A malformed destination is still a
    // caller bug, and letting it through would create a link that 302s to
    // nowhere once a customer scans the card.
    mockBatchDb();

    const { c, jsonFn } = mockContext({
      body: { links: [{ original_url: "javascript:alert(1)" }] },
    });

    await createLinksBatch(c as any);

    const body = jsonFn.mock.calls[0]![0] as any;
    expect(body.created).toBe(0);
    expect(body.failed).toBe(1);
    expect(body.results[0].status).toBe(400);
  });

  it("still rejects a non-string destination rather than reading it as absent", async () => {
    mockBatchDb();

    const { c, jsonFn } = mockContext({
      body: { links: [{ original_url: 12345 }] },
    });

    await createLinksBatch(c as any);

    const body = jsonFn.mock.calls[0]![0] as any;
    expect(body.created).toBe(0);
    expect(body.results[0].status).toBe(400);
  });

  it("still rejects a garbage item rather than making card stock of it", async () => {
    // The regression this feature invites: with original_url optional, ANY item
    // lacking that key becomes a valid card-stock link, so an import typo would
    // be reported as success for a row nobody described.
    mockBatchDb();

    const { c, jsonFn } = mockContext({
      body: { links: [item(), "not-an-object", []] },
    });

    await createLinksBatch(c as any);

    const body = jsonFn.mock.calls[0]![0] as any;
    expect(body.created).toBe(1);
    expect(body.failed).toBe(2);
    expect(body.results[1].status).toBe(400);
    expect(body.results[2].status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// The review gate and the location
//
// Until now `is_gated` shipped as a column in 00008 and was read by the
// redirect on every scan, and NOTHING could write it. The satisfaction panel
// reads `analytics.tag_ratings`, and the only thing that writes that table is
// the gate — so with no way to set the flag, the panel was decorative and
// would have read zero forever no matter how many stickers were printed.
//
// `location_id` is the same shape of gap: the per-location rollup is what the
// product is sold on, and it groups on this column.
// ---------------------------------------------------------------------------

describe("the review gate and the location", () => {
  beforeEach(() => {
    // clearAllMocks, NOT resetAllMocks — see the note above: resetAllMocks
    // strips the mocked module implementations the batch path depends on.
    vi.clearAllMocks();
    vi.mocked(generateShortCode).mockReturnValue("gen1234");
  });

  it("creates a gated link that will actually open the gate", async () => {
    const calls = mockBatchDb();

    const { c, jsonFn } = mockContext({
      body: { links: [{ original_url: "https://g.page/x", is_gated: true }] },
    });

    await createLinksBatch(c as any);

    const insert = calls.find((q) => /INSERT INTO.*links/i.test(q.sql))!;
    expect(insert.params).toContain(true);

    // Read back, so a caller need not trust that a 201 meant it worked.
    const body = jsonFn.mock.calls[0]![0] as any;
    expect(body.results[0].link.is_gated).toBe(true);
  });

  it("carries is_gated into the KV entry that the redirect reads", async () => {
    // Without this the redirect 302s straight past the gate for 24h on a warm
    // cache: the link looks created, scans record nothing, the panel stays
    // empty, and no error appears anywhere.
    mockBatchDb();

    const { c } = mockContext({
      body: { links: [{ original_url: "https://g.page/x", is_gated: true }] },
    });

    await createLinksBatch(c as any);

    const payload = JSON.parse(vi.mocked(setCachedUrl).mock.calls[0]![3] as string);
    expect(payload.isGated).toBe(true);
  });

  it("binds false, not null, when the gate was not requested", async () => {
    const calls = mockBatchDb();

    const { c } = mockContext({
      body: { links: [{ original_url: "https://a.example" }] },
    });

    await createLinksBatch(c as any);

    // is_gated is NOT NULL DEFAULT false. Binding null would let the column
    // take its default and make "off" indistinguishable from "not asked".
    const insert = calls.find((q) => /INSERT INTO.*links/i.test(q.sql))!;
    expect(insert.params).toContain(false);
  });

  it("attaches a link to a location the tenant owns", async () => {
    const calls = mockBatchDb({ ownedLocations: ["loc-1"] });

    const { c, jsonFn } = mockContext({
      body: {
        links: [{ original_url: "https://g.page/x", location_id: "loc-1" }],
      },
    });

    await createLinksBatch(c as any);

    const insert = calls.find((q) => /INSERT INTO.*links/i.test(q.sql))!;
    expect(insert.params).toContain("loc-1");

    const body = jsonFn.mock.calls[0]![0] as any;
    expect(body.results[0].link.location_id).toBe("loc-1");
  });

  it("creates a card that is gated AND attached, which is the real workflow", async () => {
    const calls = mockBatchDb({ ownedLocations: ["loc-1"] });

    const { c, jsonFn } = mockContext({
      body: {
        links: [{ is_gated: true, location_id: "loc-1", client_ref: "mesa-1" }],
      },
    });

    await createLinksBatch(c as any);

    const insert = calls.find((q) => /INSERT INTO.*links/i.test(q.sql))!;
    expect(insert.params).toContain(true);
    expect(insert.params).toContain("loc-1");

    const body = jsonFn.mock.calls[0]![0] as any;
    expect(body.created).toBe(1);
    expect(body.results[0].link.is_gated).toBe(true);
    expect(body.results[0].link.location_id).toBe("loc-1");
  });

  it("builds a pack of gated cards across several locations", async () => {
    const calls = mockBatchDb({ ownedLocations: ["loc-1", "loc-2"] });

    const { c, jsonFn } = mockContext({
      body: {
        links: [
          { is_gated: true, location_id: "loc-1" },
          { is_gated: true, location_id: "loc-1" },
          { is_gated: true, location_id: "loc-2" },
        ],
      },
    });

    await createLinksBatch(c as any);

    const body = jsonFn.mock.calls[0]![0] as any;
    expect(body.created).toBe(3);
    // Two tables, two locations — the per-location rollup can now answer
    // "which tables actually convert", which is what the product is sold on.
    expect(body.results.filter((r: any) => r.link.location_id === "loc-1")).toHaveLength(2);
    expect(body.results.filter((r: any) => r.link.location_id === "loc-2")).toHaveLength(1);
    expect(calls.length).toBeGreaterThan(0);
  });

  it("refuses a location the tenant does not own", async () => {
    // A valid uuid belonging to another tenant would attribute THIS tenant's
    // scans to THEIR numbers.
    mockBatchDb({ unknownLocations: ["loc-other"] });

    const { c, jsonFn } = mockContext({
      body: {
        links: [{ original_url: "https://g.page/x", location_id: "loc-other" }],
      },
    });

    await createLinksBatch(c as any);

    const body = jsonFn.mock.calls[0]![0] as any;
    expect(body.created).toBe(0);
    expect(body.results[0].status).toBe(400);
  });

  it("refuses a wrong-typed gate rather than silently leaving it off", async () => {
    // `is_gated: "yes"` returning 201 would leave the owner believing the gate
    // is on while customers are forwarded past it and nothing records.
    mockBatchDb();

    const { c, jsonFn } = mockContext({
      body: { links: [{ original_url: "https://g.page/x", is_gated: "yes" }] },
    });

    await createLinksBatch(c as any);

    const body = jsonFn.mock.calls[0]![0] as any;
    expect(body.created).toBe(0);
    expect(body.results[0].status).toBe(400);
  });

  it("reports which items failed rather than aborting the whole pack", async () => {
    mockBatchDb({ unknownLocations: ["loc-other"] });

    const { c, jsonFn } = mockContext({
      body: {
        links: [
          { is_gated: true },
          { is_gated: true, location_id: "loc-other" },
          { is_gated: true },
        ],
      },
    });

    await createLinksBatch(c as any);

    // A pack of stickers is worthless if one bad row loses the other nine.
    const body = jsonFn.mock.calls[0]![0] as any;
    expect(body.created).toBe(2);
    expect(body.failed).toBe(1);
    expect(body.results[1].status).toBe(400);
  });
});
