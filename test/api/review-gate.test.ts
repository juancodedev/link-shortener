import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/db/client", () => ({ withClient: vi.fn() }));

import { withClient } from "../../src/db/client";
import { reviewGateMetrics } from "../../src/api/review-gate";
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