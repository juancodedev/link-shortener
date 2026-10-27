import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/db/client", () => ({ withClient: vi.fn() }));
vi.mock("../../src/api/links", () => ({ resolveRegistryEntry: vi.fn() }));

import { withClient } from "../../src/db/client";
import { resolveRegistryEntry } from "../../src/api/links";
import { gateHandler } from "../../src/handlers/gate";

const GOOGLE_URL = "https://search.google.com/local/writereview?placeid=abc";

function resolvedEntry(over: Record<string, unknown> = {}) {
  return {
    tenantId: "tenant-uuid",
    schemaName: "tenant_a7f3",
    tenantSalt: "salt-abc",
    subdomain: "sabores",
    linkId: "link-uuid",
    displayName: "Sabores",
    ...over,
  } as any;
}

/** Captures every statement, so a test asserts what was written, not just status. */
function mockDb(rows: unknown[][] = [[], []]) {
  const calls: { sql: string; params: unknown[] }[] = [];
  let i = 0;
  vi.mocked(withClient).mockImplementation(async (_env: any, fn: any) =>
    fn({
      query: vi.fn().mockImplementation(async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        return { rows: rows[i++] ?? [], rowCount: 1 };
      }),
    }),
  );
  return calls;
}

/**
 * The default row set, in the order the handler now queries.
 *
 * The location read comes FIRST — it has to, because the rating row is written
 * with the location it resolved, and that row is what the per-location rollup
 * groups on. Then the destination read, which only the Google branch performs.
 *
 * Every row carries both columns because the handler selects both: a test that
 * omitted `location_id` would have the read return undefined and the scan would
 * be recorded unattributed, which is the very state this change removes.
 */
const DESTINATION_ROWS = [
  [{ original_url: GOOGLE_URL, location_id: null }],
  [{ original_url: GOOGLE_URL, location_id: null }],
];

function mockContext(body: string, formType = "application/x-www-form-urlencoded") {
  const jsonFn = vi.fn().mockImplementation(
    (b: unknown, s: number) => new Response(JSON.stringify(b), { status: s }),
  );
  // waitUntil must actually start the promise it is handed, the way the real
  // ExecutionContext does. A bare vi.fn() would leave the deferred INSERT
  // running past the assertions, so tests asserting on writes would read an
  // empty capture and pass or fail for the wrong reason.
  const pending: Promise<unknown>[] = [];
  const waitUntilFn = vi.fn((p: Promise<unknown>) => {
    pending.push(p);
  });
  return {
    c: {
      req: {
        raw: new Request("https://short.link/api/gate", { method: "POST" }),
        text: vi.fn().mockResolvedValue(body),
        header: vi.fn().mockReturnValue(formType),
      },
      env: { SHORT_URL_DOMAIN: "short.link" } as any,
      json: jsonFn,
      waitUntil: waitUntilFn,
      executionCtx: { waitUntil: waitUntilFn },
    },
    jsonFn,
    waitUntilFn,
    /** Drains the deferred writes so assertions see them. */
    flush: () => Promise.allSettled(pending),
  };
}

// ---------------------------------------------------------------------------
// T2.5 — POST /api/gate
// ---------------------------------------------------------------------------

describe("POST /api/gate", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(resolveRegistryEntry).mockResolvedValue(resolvedEntry());
    mockDb([[], ...DESTINATION_ROWS]);
  });

  it("returns the destination URL verbatim when the customer picks Google", async () => {
    const { c, jsonFn } = mockContext("code=mesa-01&action_taken=google_redirect");

    await gateHandler(c as any, vi.fn() as any);

    expect(jsonFn).toHaveBeenCalledWith({ redirectUrl: GOOGLE_URL }, 200);
  });

  // The compliance guarantee. If a rating ever becomes a reason to withhold the
  // link, this fails.
  it("returns the destination URL regardless of any rating supplied", async () => {
    for (const rating of ["1", "3", "5", ""]) {
      vi.resetAllMocks();
      vi.mocked(resolveRegistryEntry).mockResolvedValue(resolvedEntry());
      mockDb([[], ...DESTINATION_ROWS]);

      const { c, jsonFn } = mockContext(
        `code=mesa-01&action_taken=google_redirect&rating=${rating}`,
      );

      await gateHandler(c as any, vi.fn() as any);

      expect(jsonFn).toHaveBeenCalledWith({ redirectUrl: GOOGLE_URL }, 200);
    }
  });

  it("writes a tag_ratings row with the chosen action", async () => {
    const calls = mockDb([[], ...DESTINATION_ROWS]);
    const { c, flush } = mockContext("code=mesa-01&action_taken=google_redirect&rating=5");

    await gateHandler(c as any, vi.fn() as any);
    await flush();

    const insert = calls.find((q) => q.sql.includes("tag_ratings"));
    expect(insert).toBeDefined();
    expect(insert!.sql).toMatch(/INSERT\s+INTO\s+analytics\.tag_ratings/i);
    expect(insert!.params).toContain("google_redirect");
    expect(insert!.params).toContain(5);
  });

  it("records the rating as NULL when the customer skips the stars", async () => {
    const calls = mockDb([[], ...DESTINATION_ROWS]);
    const { c, flush } = mockContext("code=mesa-01&action_taken=google_redirect");

    await gateHandler(c as any, vi.fn() as any);
    await flush();

    const insert = calls.find((q) => q.sql.includes("tag_ratings"));
    // Param order is (tenant_id, link_id, rating, action_taken).
    expect(insert!.params[2]).toBeNull();
  });

  it("stores the comment in tag_feedback on the private branch", async () => {
    const calls = mockDb([[], ...DESTINATION_ROWS]);
    const { c, flush } = mockContext(
      "code=mesa-01&action_taken=internal_feedback&rating=2&comment=La+camarera+lleg%C3%B3+20+min+tarde&customer_contact=juan%40mail.com",
    );

    await gateHandler(c as any, vi.fn() as any);
    await flush();

    const insert = calls.find((q) => q.sql.includes("tag_feedback"));
    expect(insert).toBeDefined();
    expect(insert!.params).toContain("La camarera llegó 20 min tarde");
    expect(insert!.params).toContain("juan@mail.com");
  });

  it("stores the phone in its own column, beside the email", async () => {
    const calls = mockDb([[], ...DESTINATION_ROWS]);
    const { c, flush } = mockContext(
      "code=mesa-01&action_taken=internal_feedback&comment=Hola&customer_phone=%2B56+9+1234+5678&customer_contact=juan%40mail.com",
    );

    await gateHandler(c as any, vi.fn() as any);
    await flush();

    const insert = calls.find((q) => q.sql.includes("tag_feedback"));
    expect(insert!.sql).toMatch(/customer_contact, customer_phone/);
    // Param order is (tenant, link, location, rating, comment, email, phone).
    expect(insert!.params[5]).toBe("juan@mail.com");
    expect(insert!.params[6]).toBe("+56 9 1234 5678");
  });

  it("stores NULL for a phone the customer left blank, not an empty string", async () => {
    const calls = mockDb([[], ...DESTINATION_ROWS]);
    const { c, flush } = mockContext(
      "code=mesa-01&action_taken=internal_feedback&comment=Hola&customer_phone=+++",
    );

    await gateHandler(c as any, vi.fn() as any);
    await flush();

    const insert = calls.find((q) => q.sql.includes("tag_feedback"));
    expect(insert!.params[6]).toBeNull();
  });

  it("caps the phone length", async () => {
    const { c, jsonFn } = mockContext(
      `code=mesa-01&action_taken=internal_feedback&comment=Hola&customer_phone=${"9".repeat(41)}`,
    );

    await gateHandler(c as any, vi.fn() as any);

    expect(jsonFn).toHaveBeenCalledWith(
      expect.objectContaining({ error: "invalid_request" }),
      400,
    );
  });

  it("acknowledges the private branch with the thanks page, not a JSON envelope", async () => {
    const { c, jsonFn } = mockContext(
      "code=mesa-01&action_taken=internal_feedback&comment=Hola",
    );

    const res = (await gateHandler(c as any, vi.fn() as any)) as Response;

    expect(jsonFn).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toMatch(/text\/html/i);
    await expect(res.text()).resolves.toContain("Gracias");
  });

  it("rejects an action outside the two legal branches", async () => {
    const { c, jsonFn } = mockContext("code=mesa-01&action_taken=totally_made_up");

    await gateHandler(c as any, vi.fn() as any);

    expect(jsonFn).toHaveBeenCalledWith(
      expect.objectContaining({ error: "invalid_request" }),
      400,
    );
  });

  it("rejects a rating outside 1..5 rather than storing it", async () => {
    const calls = mockDb([[], ...DESTINATION_ROWS]);
    const { c, jsonFn } = mockContext(
      "code=mesa-01&action_taken=google_redirect&rating=99",
    );

    await gateHandler(c as any, vi.fn() as any);
    await Promise.resolve();

    expect(jsonFn).toHaveBeenCalledWith(
      expect.objectContaining({ error: "invalid_request" }),
      400,
    );
    expect(calls.find((q) => q.sql.includes("tag_ratings"))).toBeUndefined();
  });

  it("requires a comment on the private branch", async () => {
    const { c, jsonFn } = mockContext(
      "code=mesa-01&action_taken=internal_feedback&comment=",
    );

    await gateHandler(c as any, vi.fn() as any);

    expect(jsonFn).toHaveBeenCalledWith(
      expect.objectContaining({ error: "invalid_request" }),
      400,
    );
  });

  it("caps the comment length so a body cannot be used as free storage", async () => {
    const { c, jsonFn } = mockContext(
      `code=mesa-01&action_taken=internal_feedback&comment=${"x".repeat(5000)}`,
    );

    await gateHandler(c as any, vi.fn() as any);

    expect(jsonFn).toHaveBeenCalledWith(
      expect.objectContaining({ error: "invalid_request" }),
      400,
    );
  });

  it("returns 404 for a code that does not resolve", async () => {
    vi.mocked(resolveRegistryEntry).mockResolvedValue(null);

    const { c, jsonFn } = mockContext("code=nope&action_taken=google_redirect");

    await gateHandler(c as any, vi.fn() as any);

    // `{ error, code }` is the shape src/middleware/error.ts produces; a new
    // endpoint should not invent a third error dialect.
    expect(jsonFn).toHaveBeenCalledWith(
      { error: "not_found", code: "not_found" },
      404,
    );
  });

  it("rejects a missing or malformed code without touching the database", async () => {
    const calls = mockDb();
    const { c, jsonFn } = mockContext("action_taken=google_redirect");

    await gateHandler(c as any, vi.fn() as any);

    expect(jsonFn).toHaveBeenCalledWith(
      expect.objectContaining({ error: "invalid_request" }),
      400,
    );
    expect(calls).toHaveLength(0);
  });
});
// ---------------------------------------------------------------------------
// Volume guard — POST /api/gate
// ---------------------------------------------------------------------------

describe("POST /api/gate rate limiting", () => {
  /** A limiter that reports `allowed` and records the keys it was asked about. */
  function limiter(allowed: boolean) {
    const limit = vi.fn().mockResolvedValue({ success: allowed });
    return { GATE_LIMITER: { limit } as any, limit };
  }

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(resolveRegistryEntry).mockResolvedValue(resolvedEntry());
    mockDb([[], ...DESTINATION_ROWS]);
  });

  it("allows the request and records nothing unusual when under the limit", async () => {
    const { GATE_LIMITER, limit } = limiter(true);
    const { c, jsonFn } = mockContext("code=mesa-01&action_taken=google_redirect");
    c.env = { SHORT_URL_DOMAIN: "short.link", GATE_LIMITER } as any;

    await gateHandler(c as any, vi.fn() as any);

    expect(limit).toHaveBeenCalledWith({ key: "mesa-01" });
    expect(jsonFn).toHaveBeenCalledWith(
      expect.objectContaining({ redirectUrl: expect.any(String) }),
      200,
    );
  });

  // The key decision in this unit. An IP key would block a whole restaurant
  // behind one carrier NAT, at the exact moment a full room arrives together.
  it("keys on the code so one restaurant's NAT cannot lock out its own customers", async () => {
    const { GATE_LIMITER, limit } = limiter(true);
    const { c } = mockContext("code=mesa-01&action_taken=google_redirect");
    c.env = { SHORT_URL_DOMAIN: "short.link", GATE_LIMITER } as any;

    await gateHandler(c as any, vi.fn() as any);

    const { key } = limit.mock.calls[0][0] as { key: string };
    expect(key).toBe("mesa-01");
    expect(key).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
  });

  it("returns 429 once the sticker is full", async () => {
    const { GATE_LIMITER } = limiter(false);
    const { c, jsonFn } = mockContext("code=mesa-01&action_taken=google_redirect");
    c.env = { SHORT_URL_DOMAIN: "short.link", GATE_LIMITER } as any;

    await gateHandler(c as any, vi.fn() as any);

    expect(jsonFn).toHaveBeenCalledWith(
      expect.objectContaining({ error: "rate_limited" }),
      429,
    );
  });

  // A full sticker must not silently swallow a complaint and show a success
  // page — the customer would believe the local was told.
  it("writes nothing when it refuses", async () => {
    const calls = mockDb([[], ...DESTINATION_ROWS]);
    const { GATE_LIMITER } = limiter(false);
    const { c, flush } = mockContext(
      "code=mesa-01&action_taken=internal_feedback&comment=great+food",
    );
    c.env = { SHORT_URL_DOMAIN: "short.link", GATE_LIMITER } as any;

    await gateHandler(c as any, vi.fn() as any);
    await flush();

    expect(calls).toHaveLength(0);
  });

  // The form is a real navigation; fetch() is not. Someone who just typed a
  // complaint must not be shown a bare JSON envelope.
  it("shows a readable page, not JSON, when a browser submits the form", async () => {
    const { GATE_LIMITER } = limiter(false);
    const { c } = mockContext("code=mesa-01&action_taken=internal_feedback&comment=hello");
    c.env = { SHORT_URL_DOMAIN: "short.link", GATE_LIMITER } as any;
    c.req.header = vi.fn((h: string) =>
      h.toLowerCase() === "accept" ? "text/html" : "application/x-www-form-urlencoded",
    ) as any;

    const res = (await gateHandler(c as any, vi.fn() as any)) as Response;

    expect(res.status).toBe(429);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("demasiados envíos");
    // It must read as a busy room, not as a punishment.
    expect(body).not.toMatch(/prohibid|ilegal|abuso/i);
  });

  it("keeps returning JSON to the screen's own fetch", async () => {
    const { GATE_LIMITER } = limiter(false);
    const { c, jsonFn } = mockContext("code=mesa-01&action_taken=google_redirect");
    c.env = { SHORT_URL_DOMAIN: "short.link", GATE_LIMITER } as any;
    c.req.header = vi.fn((h: string) =>
      h.toLowerCase() === "accept" ? "*/*" : "application/x-www-form-urlencoded",
    ) as any;

    await gateHandler(c as any, vi.fn() as any);

    expect(jsonFn).toHaveBeenCalledWith(
      expect.objectContaining({ error: "rate_limited" }),
      429,
    );
  });

  // A limiter outage must not take the screen down for real customers.
  it("fails open when the limiter itself throws", async () => {
    const GATE_LIMITER = {
      limit: vi.fn().mockRejectedValue(new Error("limiter down")),
    } as any;
    const { c, jsonFn } = mockContext("code=mesa-01&action_taken=google_redirect");
    c.env = { SHORT_URL_DOMAIN: "short.link", GATE_LIMITER } as any;

    await gateHandler(c as any, vi.fn() as any);

    expect(jsonFn).toHaveBeenCalledWith(
      expect.objectContaining({ redirectUrl: expect.any(String) }),
      200,
    );
  });

  // Local dev and any deploy where the binding is absent must still work.
  it("works with no limiter bound at all", async () => {
    const { c, jsonFn } = mockContext("code=mesa-01&action_taken=google_redirect");

    await gateHandler(c as any, vi.fn() as any);

    expect(jsonFn).toHaveBeenCalledWith(
      expect.objectContaining({ redirectUrl: expect.any(String) }),
      200,
    );
  });

  // Junk must not be able to burn a real sticker's budget.
  it("does not spend budget on a request it was going to reject anyway", async () => {
    const { GATE_LIMITER, limit } = limiter(true);
    const { c } = mockContext("code=mesa-01&action_taken=not_a_real_branch");
    c.env = { SHORT_URL_DOMAIN: "short.link", GATE_LIMITER } as any;

    await gateHandler(c as any, vi.fn() as any);

    expect(limit).not.toHaveBeenCalled();
  });

  // And a flood of valid bodies is stopped before it reaches Postgres.
  it("stops a flood before any database work", async () => {
    const calls = mockDb([[], ...DESTINATION_ROWS]);
    const { GATE_LIMITER } = limiter(false);
    const { c, flush } = mockContext("code=mesa-01&action_taken=google_redirect");
    c.env = { SHORT_URL_DOMAIN: "short.link", GATE_LIMITER } as any;

    await gateHandler(c as any, vi.fn() as any);
    await flush();

    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Scan attribution (location_id)
//
// `tag_ratings.location_id` existed with a partial index and the panel groups
// on it, and the write hardcoded NULL — so every scan landed in "not assigned"
// and the per-location rollup, which is the table the product is sold on, could
// never answer "which tables actually convert".
//
// The link already carried its location. Nothing read it on the scan path.
// ---------------------------------------------------------------------------

describe("a scan is attributed to the link's location", () => {
  /**
   * Serves one scan, routing each statement by its SQL rather than by call
   * order.
   *
   * The queue-based `mockDb` above is fine for the older tests but cannot
   * express this path: the handler reads a location, writes a rating, and then
   * — only on the Google branch — reads the destination, and the writes consume
   * queue entries too. Ordering the fixture by hand would make a test depend on
   * how many statements each branch happens to take, which is the coupling the
   * API tests already avoid by routing on SQL text.
   */
  async function scan(
    opts: { locationId?: string | null; destination?: string | null; body?: string } = {},
  ) {
    const calls: { sql: string; params: unknown[] }[] = [];
    vi.mocked(withClient).mockImplementation(async (_env: any, fn: any) =>
      fn({
        query: vi.fn().mockImplementation(async (sql: string, params: unknown[] = []) => {
          calls.push({ sql, params });
          if (/SELECT location_id/i.test(sql)) {
            return {
              rows: [{ location_id: opts.locationId ?? null }],
              rowCount: 1,
            };
          }
          if (/SELECT original_url/i.test(sql)) {
            return {
              rows: [{ original_url: opts.destination ?? GOOGLE_URL }],
              rowCount: 1,
            };
          }
          return { rows: [], rowCount: 1 };
        }),
      }),
    );

    const { c, jsonFn, flush } = mockContext(
      opts.body ?? "code=abc1234&action_taken=google_redirect&rating=5",
    );

    await gateHandler(c as any);
    await flush();

    return { calls, jsonFn };
  }

  /** The tag_ratings INSERT, by shape rather than by call order. */
  function ratingWrite(calls: { sql: string; params: unknown[] }[]) {
    return calls.find((q) => /INSERT INTO analytics\.tag_ratings/i.test(q.sql))!;
  }

  it("writes the link's location onto the rating row", async () => {
    const { calls } = await scan({ locationId: "loc-mesa-1" });

    expect(ratingWrite(calls).params).toContain("loc-mesa-1");
  });

  it("reads the location before writing the rating, because the write needs it", async () => {
    const { calls } = await scan({ locationId: "loc-1" });

    // Ordering is load-bearing, not incidental: the location must exist before
    // the row that carries it is written.
    const locationRead = calls.findIndex((q) =>
      /SELECT location_id/i.test(q.sql),
    );
    const write = calls.findIndex((q) => /INSERT INTO analytics\.tag_ratings/i.test(q.sql));
    expect(locationRead).toBeGreaterThanOrEqual(0);
    expect(write).toBeGreaterThan(locationRead);
  });

  it("records the location on the private-feedback row too", async () => {
    const { calls } = await scan({
      locationId: "loc-1",
      body: "code=abc1234&action_taken=internal_feedback&rating=2&comment=malo",
    });

    const feedback = calls.find((q) =>
      /INSERT INTO analytics\.tag_feedback/i.test(q.sql),
    )!;
    expect(feedback.params).toContain("loc-1");
  });

  it("records NULL when the link has no location, rather than dropping the scan", async () => {
    // Unattached is a real state. A scan that cannot be attributed is still a
    // scan, and the rollup's totals must agree with the tenant-wide total.
    const { calls } = await scan({ locationId: null });

    expect(ratingWrite(calls).params).toContain(null);
    expect(ratingWrite(calls)).toBeDefined();
  });

  it("still returns the destination verbatim, whatever the location says", async () => {
    // The Google branch must not be conditioned on anything read from the link
    // beyond the destination itself.
    const { jsonFn } = await scan({ locationId: "loc-1" });

    expect(jsonFn).toHaveBeenCalledWith({ redirectUrl: GOOGLE_URL }, 200);
  });

  it("records the scan even when the location lookup fails", async () => {
    // A scan that cannot be attributed must still count. Swallowing the failure
    // and writing null is the difference between a degraded rollup and a hole in
    // the data.
    const calls: { sql: string; params: unknown[] }[] = [];
    vi.mocked(withClient).mockImplementation(async (_env: any, fn: any) =>
      fn({
        query: vi.fn().mockImplementation(async (sql: string, params: unknown[] = []) => {
          calls.push({ sql, params });
          if (/SELECT location_id/i.test(sql)) {
            throw new Error("location lookup exploded");
          }
          if (/SELECT original_url/i.test(sql)) {
            return { rows: [{ original_url: GOOGLE_URL }], rowCount: 1 };
          }
          return { rows: [], rowCount: 1 };
        }),
      }),
    );

    const { c, jsonFn, flush } = mockContext(
      "code=abc1234&action_taken=google_redirect&rating=5",
    );

    await gateHandler(c as any);
    await flush();

    expect(ratingWrite(calls)).toBeDefined();
    // And the customer still reaches Google: the failure is in attribution, not
    // in the path they asked for.
    expect(jsonFn).toHaveBeenCalledWith({ redirectUrl: GOOGLE_URL }, 200);
  });

  it("does not read the location when the private branch needs no destination", async () => {
    // A customer who chose to leave private feedback is already on a page that
    // does not navigate. Reading a destination they will never use is a round
    // trip taken for nothing.
    const { calls } = await scan({
      locationId: "loc-1",
      body: "code=abc1234&action_taken=internal_feedback&rating=1&comment=x",
    });

    expect(calls.some((q) => /SELECT original_url/i.test(q.sql))).toBe(false);
  });
});
