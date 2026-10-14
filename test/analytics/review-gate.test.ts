import { describe, it, expect } from "vitest";
import {
  MIN_RATED_SAMPLE,
  buildActionSplitQuery,
  buildLocationRollupQuery,
  buildPeakTrafficQuery,
  toActionSplit,
  toLocationRollup,
  toPeakBucket,
  PEAK_BUCKET_SECONDS,
} from "../../src/analytics/review-gate";

// ---------------------------------------------------------------------------
// The numbers the dashboard shows about the dual-path action screen.
//
// Every figure here comes from `analytics.tag_ratings`, which lives in a shared
// schema precisely so the dashboard can roll a tenant's whole estate up in one
// query instead of touching N tenant schemas.
//
// THE HONESTY CONSTRAINT
//
// `rating` is NULLABLE. Stars are an optional sentiment signal collected beside
// the action, not the branch — requiring one would add a step to the path the
// product exists to make fast. So most customers skip them.
//
// That means a mean rating is computed from a self-selected minority, and on a
// small tenant the error bars are enormous. A mean shown without its sample
// size is a number the owner will act on and that the data does not support.
// So every average in this module carries its `n`, and below MIN_RATED_SAMPLE
// it is not reported at all — null, not a rounded number.
// ---------------------------------------------------------------------------

const TENANT_ID = "tenant-uuid";

describe("action split and derivation rate", () => {
  it("counts both branches and the rated subset per branch", () => {
    const { text, params } = buildActionSplitQuery(TENANT_ID);

    expect(text).toMatch(/analytics\.tag_ratings/i);
    expect(text).toMatch(/action_taken/i);
    expect(params).toContain(TENANT_ID);
  });

  it("counts scans and rated scans as different things", () => {
    // The distinction is the whole point: a branch's scan count is the
    // denominator for the derivation rate, while its rated count is what any
    // average is computed over. Collapsing them would silently inflate or
    // deflate every satisfaction figure.
    const { text } = buildActionSplitQuery(TENANT_ID);
    expect(text).toMatch(/COUNT\(\*\)/);
    expect(text).toMatch(/COUNT\(r\.rating\)/);
  });

  it("averages only the rows that carry a rating", () => {
    const { text } = buildActionSplitQuery(TENANT_ID);
    // AVG ignores NULLs by definition, so no extra filter is needed. What
    // matters is that the AVERAGE and the COUNT it is paired with are both
    // rating-aware: COUNT(*) would average over rows that never rated.
    expect(text).toMatch(/AVG\(r\.rating\)/);
    expect(text).toMatch(/COUNT\(r\.rating\)/);
    expect(text).not.toMatch(/AVG\(\s*\*/);
  });

  it("returns null for the average rather than zero when nothing was rated", () => {
    // AVG over zero rows is NULL in SQL, which is the correct answer. Coercing
    // it to 0 would read as "every customer rated it 1 star".
    const split = toActionSplit({
      google: { scans: "10", rated: "0", avg_rating: null },
      private: { scans: "2", rated: "0", avg_rating: null },
    });

    expect(split.google.avgRating).toBeNull();
    expect(split.private.avgRating).toBeNull();
    expect(split.sentimentGap).toBeNull();
  });

  it("derives the rate from the Google branch over every scan", () => {
    const split = toActionSplit({
      google: { scans: "8", rated: "4", avg_rating: "4.5" },
      private: { scans: "2", rated: "2", avg_rating: "2.0" },
    });

    expect(split.totalScans).toBe(10);
    expect(split.derivationRate).toBeCloseTo(0.8, 5);
  });

  it("reports zero rate when nothing has been scanned, never NaN", () => {
    const split = toActionSplit({
      google: { scans: "0", rated: "0", avg_rating: null },
      private: { scans: "0", rated: "0", avg_rating: null },
    });

    expect(split.totalScans).toBe(0);
    expect(split.derivationRate).toBe(0);
    expect(split.sentimentGap).toBeNull();
  });

  it("carries the sample size beside every average", () => {
    const split = toActionSplit({
      google: { scans: "8", rated: "4", avg_rating: "4.5" },
      private: { scans: "2", rated: "2", avg_rating: "2.0" },
    });

    expect(split.google.rated).toBe(4);
    expect(split.private.rated).toBe(2);
  });
});

describe("satisfaction is withheld below the sample floor", () => {
  it("publishes no average when a branch has too few ratings", () => {
    const split = toActionSplit({
      google: { scans: "9", rated: "2", avg_rating: "5.0" },
      private: { scans: "1", rated: "1", avg_rating: "1.0" },
    });

    // Two customers rating 5 and nothing else is not a satisfaction signal.
    expect(split.google.avgRating).toBeNull();
    expect(split.google.rated).toBe(2);
  });

  it("publishes the average once the sample clears the floor", () => {
    const rated = String(MIN_RATED_SAMPLE);
    const split = toActionSplit({
      google: { scans: "9", rated, avg_rating: "4.4" },
      private: { scans: "1", rated: "1", avg_rating: "1.0" },
    });

    expect(split.google.avgRating).toBeCloseTo(4.4, 5);
  });

  it("reports no gap unless BOTH branches cleared the floor", () => {
    // A gap between one measured branch and one unmeasured one is not a gap;
    // it is an artefact of which customers happened to rate.
    const rated = String(MIN_RATED_SAMPLE);
    const split = toActionSplit({
      google: { scans: "20", rated, avg_rating: "4.6" },
      private: { scans: "1", rated: "1", avg_rating: "1.0" },
    });

    expect(split.sentimentGap).toBeNull();
  });

  it("computes the gap when both branches cleared the floor", () => {
    const rated = String(MIN_RATED_SAMPLE);
    const split = toActionSplit({
      google: { scans: "20", rated, avg_rating: "4.6" },
      private: { scans: "20", rated, avg_rating: "2.4" },
    });

    expect(split.sentimentGap).toBeCloseTo(2.2, 5);
  });

  it("marks the sample floor as small enough to be visible", () => {
    // This constant is rendered on the dashboard. If it changes, the label
    // next to the number changes with it.
    expect(MIN_RATED_SAMPLE).toBeGreaterThanOrEqual(5);
  });
});

describe("per-location rollup", () => {
  it("groups by location and names it", () => {
    const { text, params } = buildLocationRollupQuery(TENANT_ID);

    expect(text).toMatch(/analytics\.tag_ratings/i);
    expect(text).toMatch(/public\.locations/i);
    expect(text).toMatch(/GROUP BY/i);
    expect(params).toContain(TENANT_ID);
  });

  it("scopes to the tenant, so one business cannot read another's numbers", () => {
    const { text, params } = buildLocationRollupQuery(TENANT_ID);
    expect(text).toMatch(/tenant_id\s*=\s*\$1/);
    expect(params[0]).toBe(TENANT_ID);
  });

  it("keeps unassigned scans out of the zonal table but counts them", () => {
    const { text } = buildLocationRollupQuery(TENANT_ID);
    // A LEFT JOIN keeps a scan whose location was deleted, and grouping by the
    // nullable id surfaces those as their own row rather than dropping them.
    expect(text).toMatch(/LEFT\s+JOIN/i);
    expect(text).toMatch(/GROUP BY/i);
  });

  it("returns both actions per location with their rated counts", () => {
    const { text } = buildLocationRollupQuery(TENANT_ID);
    expect(text).toMatch(/COUNT\(\*\)/);
    expect(text).toMatch(/COUNT\(r\.rating\)/);
  });

  it("coerces a driver row into numbers", () => {
    const row = toLocationRollup({
      location_id: "loc-1",
      location_name: "Mesa 1",
      google_scans: "12",
      google_rated: "6",
      private_scans: "3",
      private_rated: "2",
    });

    expect(row.googleScans).toBe(12);
    expect(row.privateRated).toBe(2);
    expect(row.derivationRate).toBeCloseTo(0.8, 5);
  });

  it("reports a zero rate, not NaN, for a location with no scans", () => {
    const row = toLocationRollup({
      location_id: null,
      location_name: null,
      google_scans: "0",
      google_rated: "0",
      private_scans: "0",
      private_rated: "0",
    });

    expect(row.locationId).toBeNull();
    expect(row.derivationRate).toBe(0);
  });
});

describe("peak traffic", () => {
  it("buckets on fixed epoch widths, not date_trunc", () => {
    // Same reasoning as the session buckets in metrics.ts: a date_trunc
    // bucket drifts with the session time zone and stops meaning the same
    // thing across two requests.
    const { text } = buildPeakTrafficQuery(TENANT_ID);
    expect(text).toMatch(/extract\(epoch\s+FROM/i);
    expect(text).not.toMatch(/date_trunc/i);
  });

  it("scopes to the tenant and to a window", () => {
    const { text, params } = buildPeakTrafficQuery(TENANT_ID);
    expect(text).toMatch(/tenant_id\s*=\s*\$1/);
    expect(text).toMatch(/NOW\(\)\s*-\s*CAST\(\$2\s+AS\s+interval\)/i);
    expect(params[0]).toBe(TENANT_ID);
    expect(params[1]).toBeTypeOf("string");
  });

  it("uses a one-hour bucket for the hourly view", () => {
    expect(PEAK_BUCKET_SECONDS).toBe(3600);
  });

  it("converts a bucket back to whole seconds", () => {
    const bucket = toPeakBucket({
      bucket: "1767225600",
      google: "4",
      private: "1",
    });

    expect(bucket.bucketStart).toBe(1767225600);
    expect(bucket.total).toBe(5);
    expect(bucket.derivationRate).toBeCloseTo(0.8, 5);
  });

  it("orders buckets by time so the caller does not have to", () => {
    const { text } = buildPeakTrafficQuery(TENANT_ID);
    expect(text).toMatch(/ORDER BY/i);
  });
});