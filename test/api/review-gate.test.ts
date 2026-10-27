import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/db/client", () => ({ withClient: vi.fn() }));

import { withClient } from "../../src/db/client";
import {
  FEEDBACK_EXPORT_LIMIT,
  FEEDBACK_PAGE_SIZE,
  exportFeedbackCsv,
  listFeedback,
  reviewGateMetrics,
} from "../../src/api/review-gate";
import { MIN_RATED_SAMPLE } from "../../src/analytics/review-gate";

// ---------------------------------------------------------------------------
// GET /api/review-gate/metrics
//
// The panel's three views in one response: the action split, the per-location
// rollup, and the hourly peaks. One request because they describe the same
// scans and the dashboard renders them side by side; three requests would let
// the numbers on one screen describe slightly different moments.
// ---------------------------------------------------------------------------

function mockContext() {
  const jsonFn = vi.fn().mockImplementation(
    (body: unknown, status: number) => new Response(JSON.stringify(body), { status }),
  );
  return {
    c: {
      get: vi.fn().mockReturnValue({
        tenantSlug: "sabores",
        schemaName: "tenant_a7f3",
        tenantId: "tenant-uuid",
        tenantSalt: "salt",
      }),
      env: { SHORT_URL_DOMAIN: "short.link" } as any,
      json: jsonFn,
    },
    jsonFn,
  };
}

/** Routes query() by the table it names, so a test states what each returns. */
function mockDb(overrides: {
  split?: unknown[];
  locations?: unknown[];
  peaks?: unknown[];
  throwsOn?: string;
} = {}) {
  const calls: { sql: string; params: unknown[] }[] = [];

  vi.mocked(withClient).mockImplementation(async (_env: any, fn: any) =>
    fn({
      query: vi.fn().mockImplementation(async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        if (overrides.throwsOn && sql.includes(overrides.throwsOn)) {
          throw new Error(`${overrides.throwsOn} query failed`);
        }
        if (sql.includes("tag_ratings r") && sql.includes("GROUP BY b.bucket")) {
          return { rows: overrides.peaks ?? [], rowCount: 1 };
        }
        if (sql.includes("GROUP BY r.location_id")) {
          return { rows: overrides.locations ?? [], rowCount: 1 };
        }
        return { rows: overrides.split ?? [], rowCount: 1 };
      }),
    }),
  );

  return calls;
}

const SPLIT_ROW = {
  google_scans: "8",
  google_rated: "6",
  google_avg: "4.5",
  private_scans: "2",
  private_rated: "1",
  private_avg: "3.0",
};

describe("review-gate metrics endpoint", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns the split, the rollup and the peaks", async () => {
    mockDb({
      split: [SPLIT_ROW],
      locations: [
        {
          location_id: "loc-1",
          location_name: "Mesa 1",
          google_scans: "5",
          google_rated: "3",
          private_scans: "1",
          private_rated: "0",
        },
      ],
      peaks: [{ bucket: "1767225600", google: "3", private: "1" }],
    });

    const { c, jsonFn } = mockContext();

    await reviewGateMetrics(c as any, vi.fn() as any);

    const body = jsonFn.mock.calls[0]![0] as any;
    expect(body).toHaveProperty("split");
    expect(body).toHaveProperty("locations");
    expect(body).toHaveProperty("peaks");
  });

  it("derives the rate and the gap in the response", async () => {
    mockDb({ split: [SPLIT_ROW] });

    const { c, jsonFn } = mockContext();

    await reviewGateMetrics(c as any, vi.fn() as any);

    const body = jsonFn.mock.calls[0]![0] as any;
    expect(body.split.totalScans).toBe(10);
    expect(body.split.derivationRate).toBeCloseTo(0.8, 5);
    // private rated 1 < MIN_RATED_SAMPLE, so the gap is withheld.
    expect(body.split.sentimentGap).toBeNull();
  });

  it("ships the sample floor so the dashboard cannot drift from it", async () => {
    mockDb({ split: [SPLIT_ROW] });

    const { c, jsonFn } = mockContext();

    await reviewGateMetrics(c as any, vi.fn() as any);

    const body = jsonFn.mock.calls[0]![0] as any;
    // The label "muestra insuficiente" needs the number that decides it. A
    // hardcoded copy on the client would drift the first time the constant
    // moved, and the panel would start claiming a mean is fine at n=4.
    expect(body.meta.minRatedSample).toBe(MIN_RATED_SAMPLE);
  });

  it("reports no gap when a branch is under the floor", async () => {
    mockDb({ split: [SPLIT_ROW] });

    const { c, jsonFn } = mockContext();

    await reviewGateMetrics(c as any, vi.fn() as any);

    const body = jsonFn.mock.calls[0]![0] as any;
    expect(body.split.private.avgRating).toBeNull();
    expect(body.split.google.avgRating).toBeCloseTo(4.5, 5);
    // The raw count still ships — the owner sees "1 de 2", which is information,
    // even though no mean is computed from it.
    expect(body.split.private.rated).toBe(1);
    expect(body.split.private.scans).toBe(2);
  });

  it("scopes every query to the tenant from the context", async () => {
    const calls = mockDb({ split: [SPLIT_ROW] });

    const { c } = mockContext();

    await reviewGateMetrics(c as any, vi.fn() as any);

    for (const call of calls) {
      expect(call.params[0]).toBe("tenant-uuid");
    }
  });

  it("returns empty collections, not nulls, when nothing has been scanned", async () => {
    mockDb({ split: [] });

    const { c, jsonFn } = mockContext();

    await reviewGateMetrics(c as any, vi.fn() as any);

    const body = jsonFn.mock.calls[0]![0] as any;
    expect(body.locations).toEqual([]);
    expect(body.peaks).toEqual([]);
    expect(body.split.totalScans).toBe(0);
    expect(body.split.derivationRate).toBe(0);
  });

  it("fails loudly when a query fails, rather than reporting a confident zero", async () => {
    // A missing panel is honest. A dashboard reading "0 scans today" when the
    // database is unreachable is a lie the owner will act on.
    mockDb({ throwsOn: "tag_ratings" });

    const { c } = mockContext();

    await expect(reviewGateMetrics(c as any, vi.fn() as any)).rejects.toThrow();
  });
});
// ---------------------------------------------------------------------------
// GET /api/review-gate/feedback and /feedback.csv
//
// The inbox: the text customers actually wrote. Both handlers read their
// filters off `c.req.url`, so the context here carries one.
// ---------------------------------------------------------------------------

const LOCATION_ID = "3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b";

function feedbackContext(url = "https://api.test/api/review-gate/feedback", authenticated = true) {
  const jsonFn = vi.fn().mockImplementation(
    (body: unknown, status = 200) => new Response(JSON.stringify(body), { status }),
  );
  return {
    c: {
      get: vi.fn().mockReturnValue(
        authenticated
          ? { tenantSlug: "sabores", schemaName: "tenant_a7f3", tenantId: "tenant-uuid", tenantSalt: "salt" }
          : undefined,
      ),
      env: {} as any,
      req: { url },
      json: jsonFn,
    },
    jsonFn,
  };
}

/** Every call to the feedback query, with the rows it should return. */
function mockFeedbackDb(rows: unknown[]) {
  const calls: { sql: string; params: unknown[] }[] = [];
  vi.mocked(withClient).mockImplementation(async (_env: any, fn: any) =>
    fn({
      query: vi.fn().mockImplementation(async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        return { rows, rowCount: rows.length };
      }),
    }),
  );
  return calls;
}

function feedbackRow(over: Record<string, unknown> = {}) {
  return {
    id: "fb-1",
    comment: "The soup was cold",
    rating: 2,
    customer_contact: null,
    customer_phone: null,
    scanned_at: "2026-10-14T20:15:00.000Z",
    short_code: "abc123",
    client_ref: "mesa-4",
    location_name: "Terraza",
    business_name: "Sabores",
    ...over,
  };
}

describe("review-gate feedback list", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns the rows in the order the query gave them, newest first", async () => {
    const calls = mockFeedbackDb([
      feedbackRow({ id: "new", scanned_at: "2026-10-14T20:15:00Z" }),
      feedbackRow({ id: "old", scanned_at: "2026-10-01T09:00:00Z" }),
    ]);
    const { c, jsonFn } = feedbackContext();

    await listFeedback(c as any, vi.fn() as any);

    const body = jsonFn.mock.calls[0]![0] as any;
    expect(body.feedback.map((r: any) => r.id)).toEqual(["new", "old"]);
    expect(body.feedback[0]).toEqual({
      id: "new",
      comment: "The soup was cold",
      rating: 2,
      customer_contact: null,
      customer_phone: null,
      scanned_at: "2026-10-14T20:15:00.000Z",
      short_code: "abc123",
      client_ref: "mesa-4",
      location_name: "Terraza",
      business_name: "Sabores",
    });
    // The id breaks ties: two comments in the same instant must come back in
    // the same order on every read, or the list and the export disagree.
    expect(calls[0]!.sql).toMatch(/ORDER BY f\.scanned_at DESC, f\.id DESC/);
    expect(body.truncated).toBe(false);
    expect(body.limit).toBe(FEEDBACK_PAGE_SIZE);
  });

  it("returns the phone the customer left, beside the email", async () => {
    const calls = mockFeedbackDb([
      feedbackRow({ customer_phone: "+56 9 1234 5678", customer_contact: "ana@example.com" }),
    ]);
    const { c, jsonFn } = feedbackContext();

    await listFeedback(c as any, vi.fn() as any);

    const body = jsonFn.mock.calls[0]![0] as any;
    expect(calls[0]!.sql).toMatch(/f\.customer_phone/);
    expect(body.feedback[0].customer_phone).toBe("+56 9 1234 5678");
    expect(body.feedback[0].customer_contact).toBe("ana@example.com");
  });

  it("keeps the milliseconds when the driver returns scanned_at as a Date", async () => {
    // node-postgres hands timestamptz back as a Date. Going through String()
    // renders it without milliseconds, so two comments a few ms apart would
    // collapse to the same second.
    mockFeedbackDb([feedbackRow({ scanned_at: new Date("2026-10-14T20:15:00.123Z") })]);
    const { c, jsonFn } = feedbackContext();

    await listFeedback(c as any, vi.fn() as any);

    expect((jsonFn.mock.calls[0]![0] as any).feedback[0].scanned_at).toBe("2026-10-14T20:15:00.123Z");
  });

  it("keeps a comment with no rating and no location", async () => {
    mockFeedbackDb([
      feedbackRow({ rating: null, location_name: null, client_ref: null, short_code: null }),
    ]);
    const { c, jsonFn } = feedbackContext();

    await listFeedback(c as any, vi.fn() as any);

    const row = (jsonFn.mock.calls[0]![0] as any).feedback[0];
    expect(row.rating).toBeNull();
    expect(row.location_name).toBeNull();
    expect(row.comment).toBe("The soup was cold");
  });

  it("scopes the query to the tenant and to the tenant's own links table", async () => {
    const calls = mockFeedbackDb([]);
    const { c } = feedbackContext();

    await listFeedback(c as any, vi.fn() as any);

    expect(calls[0]!.params[0]).toBe("tenant-uuid");
    expect(calls[0]!.sql).toContain("f.tenant_id = $1");
    expect(calls[0]!.sql).toMatch(/"?tenant_a7f3"?\."?links"?/);
  });

  it("names the business of every comment, through its branch", async () => {
    const calls = mockFeedbackDb([feedbackRow()]);
    const { c, jsonFn } = feedbackContext();

    await listFeedback(c as any, vi.fn() as any);

    expect(calls[0]!.sql).toMatch(/LEFT JOIN public\.businesses b ON b\.id = loc\.business_id/);
    expect((jsonFn.mock.calls[0]![0] as any).feedback[0].business_name).toBe("Sabores");
  });

  it("filters by business as a bind parameter", async () => {
    const id = "44444444-4444-4444-8444-444444444444";
    const calls = mockFeedbackDb([]);
    const { c } = feedbackContext(`https://api.test/api/review-gate/feedback?business_id=${id}`);

    await listFeedback(c as any, vi.fn() as any);

    expect(calls[0]!.sql).toMatch(/loc\.business_id = \$2/);
    expect(calls[0]!.params[1]).toBe(id);
  });

  it("rejects a business_id that is not a uuid before touching the database", async () => {
    const calls = mockFeedbackDb([]);
    const { c, jsonFn } = feedbackContext("https://api.test/api/review-gate/feedback?business_id=nope");

    await listFeedback(c as any, vi.fn() as any);

    expect(jsonFn).toHaveBeenCalledWith({ error: "invalid_business_id" }, 400);
    expect(calls).toHaveLength(0);
  });

  it("passes valid filters as bind parameters, with since normalised to ISO", async () => {
    const calls = mockFeedbackDb([]);
    const { c } = feedbackContext(
      `https://api.test/api/review-gate/feedback?location_id=${LOCATION_ID}&since=2026-10-01`,
    );

    await listFeedback(c as any, vi.fn() as any);

    expect(calls[0]!.params).toContain(LOCATION_ID);
    expect(calls[0]!.params).toContain("2026-10-01T00:00:00.000Z");
  });

  it("reports truncated when there are more rows than the page holds", async () => {
    // The handler asks for one more than it shows. Getting it back is how it
    // knows the page is not the whole inbox.
    const rows = Array.from({ length: FEEDBACK_PAGE_SIZE + 1 }, (_, i) => feedbackRow({ id: `fb-${i}` }));
    mockFeedbackDb(rows);
    const { c, jsonFn } = feedbackContext();

    await listFeedback(c as any, vi.fn() as any);

    const body = jsonFn.mock.calls[0]![0] as any;
    expect(body.truncated).toBe(true);
    expect(body.feedback).toHaveLength(FEEDBACK_PAGE_SIZE);
  });

  it("does not report truncated when the inbox is exactly one page", async () => {
    const rows = Array.from({ length: FEEDBACK_PAGE_SIZE }, (_, i) => feedbackRow({ id: `fb-${i}` }));
    mockFeedbackDb(rows);
    const { c, jsonFn } = feedbackContext();

    await listFeedback(c as any, vi.fn() as any);

    expect((jsonFn.mock.calls[0]![0] as any).truncated).toBe(false);
  });

  it.each([
    ["location_id=not-a-uuid", "invalid_location_id"],
    ["location_id=1;DROP TABLE x", "invalid_location_id"],
    ["since=yesterday-ish", "invalid_since"],
    ["since=2026-13-45", "invalid_since"],
    ["since=1999-12-31", "invalid_since"],
    ["since=%2B010000-01-01", "invalid_since"],
  ])("rejects %s with 400 before touching the database", async (query, error) => {
    mockFeedbackDb([]);
    const { c } = feedbackContext(`https://api.test/api/review-gate/feedback?${query}`);

    const res = (await listFeedback(c as any, vi.fn() as any)) as Response;

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error });
    expect(withClient).not.toHaveBeenCalled();
  });

  it("refuses an unauthenticated caller", async () => {
    mockFeedbackDb([]);
    const { c } = feedbackContext(undefined, false);

    const res = (await listFeedback(c as any, vi.fn() as any)) as Response;

    expect(res.status).toBe(401);
    expect(withClient).not.toHaveBeenCalled();
  });
});

describe("review-gate feedback CSV export", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  const CSV_URL = "https://api.test/api/review-gate/feedback.csv";

  it("serves a private attachment that no shared cache may keep", async () => {
    mockFeedbackDb([feedbackRow()]);
    const { c } = feedbackContext(CSV_URL);

    const res = (await exportFeedbackCsv(c as any, vi.fn() as any)) as Response;

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(res.headers.get("Content-Disposition")).toBe(
      'attachment; filename="customer-feedback.csv"',
    );
    expect(res.headers.get("X-Truncated")).toBe("false");
  });

  it("escapes the comment and neutralises a formula", async () => {
    mockFeedbackDb([
      feedbackRow({ comment: 'slow, and "rude"\nnever again', rating: null }),
      feedbackRow({ comment: "=HYPERLINK(\"http://evil.example\")" }),
    ]);
    const { c } = feedbackContext(CSV_URL);

    const res = (await exportFeedbackCsv(c as any, vi.fn() as any)) as Response;
    const text = await res.text();

    expect(text.split("\n")[0]).toBe(
      "scanned_at,location,client_ref,short_code,rating,customer_contact,comment,customer_phone,business",
    );
    expect(text).toContain(
      '2026-10-14T20:15:00.000Z,Terraza,mesa-4,abc123,,,"slow, and ""rude""\nnever again",,Sabores',
    );
    expect(text).toContain(`"'=HYPERLINK(""http://evil.example"")"`);
    expect(text.endsWith("\n")).toBe(true);
  });

  it("says so in a header when the export hit its cap", async () => {
    const rows = Array.from({ length: FEEDBACK_EXPORT_LIMIT + 1 }, (_, i) => feedbackRow({ id: `fb-${i}` }));
    mockFeedbackDb(rows);
    const { c } = feedbackContext(CSV_URL);

    const res = (await exportFeedbackCsv(c as any, vi.fn() as any)) as Response;
    const text = await res.text();

    expect(res.headers.get("X-Truncated")).toBe("true");
    // Header line + exactly the cap, then the trailing newline's empty tail.
    expect(text.split("\n")).toHaveLength(FEEDBACK_EXPORT_LIMIT + 2);
  });

  it("rejects an invalid filter with 400 before touching the database", async () => {
    mockFeedbackDb([]);
    const { c } = feedbackContext(`${CSV_URL}?since=not-a-date`);

    const res = (await exportFeedbackCsv(c as any, vi.fn() as any)) as Response;

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_since" });
    expect(withClient).not.toHaveBeenCalled();
  });

  it("refuses an unauthenticated caller", async () => {
    mockFeedbackDb([]);
    const { c } = feedbackContext(CSV_URL, false);

    const res = (await exportFeedbackCsv(c as any, vi.fn() as any)) as Response;

    expect(res.status).toBe(401);
    expect(withClient).not.toHaveBeenCalled();
  });
});
