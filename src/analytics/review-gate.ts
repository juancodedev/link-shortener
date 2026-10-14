// ---------------------------------------------------------------------------
// Review-gate analytics — the numbers the dashboard shows about the action
// screen.
//
// Everything here reads `analytics.tag_ratings`, which lives in a shared schema
// rather than in a tenant's own. That is the whole reason it can answer "how
// did every table in this business do" in ONE query. A per-tenant table would
// make the dashboard issue N queries, one per tenant schema, and the whole
// point of the product is the multi-location view.
//
// THE HONESTY CONSTRAINT — READ THIS BEFORE USING ANY AVERAGE
//
// `rating` is NULLABLE. Stars are an optional sentiment signal collected beside
// the action, never the branch; requiring one would add a step to the path the
// product exists to make fast. Most customers skip them.
//
// So every average in this module is computed over a self-selected minority, and
// on a small tenant the error bars are enormous. A mean rating shown without its
// sample size is a number the owner will act on and that the data does not
// support.
//
// Therefore:
//   - every average carries its `n` beside it
//   - below MIN_RATED_SAMPLE, no average is published at all — null, not a
//     rounded number
//   - the gap between the two branches is null unless BOTH cleared the floor,
//     because a gap between one measured branch and one unmeasured one is an
//     artefact of who happened to rate, not a signal
//
// The same discipline `metrics.ts` applies to the visitor caveat applies here:
// the limitation travels WITH the number, not in a tooltip nobody opens.
// ---------------------------------------------------------------------------

import type { BoundQuery } from "./metrics";

/**
 * Minimum rated scans before a satisfaction average is published.
 *
 * Five is deliberately conservative. On a 1-5 scale a handful of responses can
 * land anywhere from 1.0 to 5.0, so a mean over three responses is not a weak
 * signal — it is noise wearing a decimal point. Below the floor the dashboard
 * shows the raw counts and says the sample is too small, which is the honest
 * answer and is more useful to the owner than a confident wrong number.
 *
 * Rendered on the dashboard, so a change here changes the label next to the
 * figure.
 */
export const MIN_RATED_SAMPLE = 5;

/** Width of one peak-traffic bucket: the hourly view. */
export const PEAK_BUCKET_SECONDS = 3600;

/** Rolling horizon for the peak view, so the chart shows something on day one. */
export const PEAK_WINDOW = "7 days";

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

/** One branch of the action split, as Postgres returns it. */
interface BranchRow {
  scans: number | string;
  rated: number | string;
  avg_rating: number | string | null;
}

export interface ActionSplitRow {
  google: BranchRow;
  private: BranchRow;
}

/** One branch of the action split, after coercion. */
export interface ActionBranch {
  /** Every scan that took this branch, rated or not. The denominator. */
  scans: number;
  /** How many of those carried a rating. The average is computed over this. */
  rated: number;
  /** Mean rating, or null when the sample is below the floor. */
  avgRating: number | null;
}

export interface ActionSplit {
  google: ActionBranch;
  private: ActionBranch;
  totalScans: number;
  /** Share of scans that took the Google action. */
  derivationRate: number;
  /**
   * Mean rating of the Google branch minus the private branch, or null unless
   * both cleared MIN_RATED_SAMPLE.
   */
  sentimentGap: number | null;
}

export interface LocationRollupRow {
  location_id: string | null;
  location_name: string | null;
  google_scans: number | string;
  google_rated: number | string;
  private_scans: number | string;
  private_rated: number | string;
}

export interface LocationRollup {
  locationId: string | null;
  locationName: string | null;
  googleScans: number;
  googleRated: number;
  privateScans: number;
  privateRated: number;
  totalScans: number;
  derivationRate: number;
}

export interface PeakBucketRow {
  bucket: number | string;
  google: number | string;
  private: number | string;
}

export interface PeakBucket {
  /** Epoch seconds at the start of the bucket. */
  bucketStart: number;
  google: number;
  private: number;
  total: number;
  derivationRate: number;
}

// ---------------------------------------------------------------------------
// Coercion
// ---------------------------------------------------------------------------

/** Postgres hands COUNT/AVG back in ways `pg` may deliver as strings. */
function num(value: number | string | null): number | null {
  if (value === null || value === undefined) return null;
  return Number(value);
}

/** A share, defined as 0 rather than NaN when there is nothing to divide. */
function rate(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return part / whole;
}

/**
 * One branch, coerced and floor-checked.
 *
 * The floor check is the reason this is a function and not a field copy: an
 * average is published only when `rated` clears MIN_RATED_SAMPLE, so no caller
 * can reach the number by forgetting the rule.
 */
function toBranch(row: BranchRow): ActionBranch {
  const scans = Number(row.scans);
  const rated = Number(row.rated);
  const avg = num(row.avg_rating);

  return {
    scans,
    rated,
    avgRating: rated >= MIN_RATED_SAMPLE && avg !== null ? avg : null,
  };
}

/** Coerces both branches and derives the three headline figures. */
export function toActionSplit(row: ActionSplitRow): ActionSplit {
  const google = toBranch(row.google);
  const privateBranch = toBranch(row.private);
  const totalScans = google.scans + privateBranch.scans;

  // A gap needs two measurements. One measured branch and one unmeasured is not
  // a gap; it is an artefact of which customers bothered to rate.
  const sentimentGap =
    google.avgRating !== null && privateBranch.avgRating !== null
      ? google.avgRating - privateBranch.avgRating
      : null;

  return {
    google,
    private: privateBranch,
    totalScans,
    derivationRate: rate(google.scans, totalScans),
    sentimentGap,
  };
}

export function toLocationRollup(row: LocationRollupRow): LocationRollup {
  const googleScans = Number(row.google_scans);
  const privateScans = Number(row.private_scans);
  const totalScans = googleScans + privateScans;

  return {
    locationId: row.location_id,
    locationName: row.location_name,
    googleScans,
    googleRated: Number(row.google_rated),
    privateScans,
    privateRated: Number(row.private_rated),
    totalScans,
    derivationRate: rate(googleScans, totalScans),
  };
}

export function toPeakBucket(row: PeakBucketRow): PeakBucket {
  const google = Number(row.google);
  const privateBranch = Number(row.private);
  const total = google + privateBranch;

  return {
    bucketStart: Number(row.bucket),
    google,
    private: privateBranch,
    total,
    derivationRate: rate(google, total),
  };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * Action split, derivation rate, and the satisfaction gap for one tenant.
 *
 * One pass over `analytics.tag_ratings` produces both branches, because the
 * two are read together: the derivation rate is `google / total`, and the
 * satisfaction gap is the difference between their means. Splitting them into
 * separate queries would let the two halves describe slightly different windows
 * and produce a gap that never existed.
 *
 * `COUNT(*)` and `COUNT(rating)` are deliberately different columns. The first
 * is the denominator for the rate; the second is what any average is computed
 * over. A customer who tapped through without rating has taken an action and has
 * an opinion, and counting them in only one of the two would skew whichever
 * figure used the wrong one.
 *
 * The tenant predicate is the isolation boundary. `tag_ratings.link_id` has no
 * foreign key — links live in per-tenant schemas — so `tenant_id` on the row is
 * the only thing scoping this to one business.
 */
export function buildActionSplitQuery(tenantId: string): BoundQuery {
  return {
    text: `SELECT
              COUNT(*) FILTER (WHERE r.action_taken = 'google_redirect')::int   AS google_scans,
              COUNT(r.rating) FILTER (WHERE r.action_taken = 'google_redirect')::int AS google_rated,
              AVG(r.rating) FILTER (WHERE r.action_taken = 'google_redirect')          AS google_avg,
              COUNT(*) FILTER (WHERE r.action_taken = 'internal_feedback')::int AS private_scans,
              COUNT(r.rating) FILTER (WHERE r.action_taken = 'internal_feedback')::int AS private_rated,
              AVG(r.rating) FILTER (WHERE r.action_taken = 'internal_feedback')          AS private_avg
         FROM analytics.tag_ratings r
        WHERE r.tenant_id = $1`,
    params: [tenantId],
  };
}

/** Raw rows of the action split, in the shape `toActionSplit` expects. */
export function splitRows(row: {
  google_scans: number | string;
  google_rated: number | string;
  google_avg: number | string | null;
  private_scans: number | string;
  private_rated: number | string;
  private_avg: number | string | null;
}): ActionSplitRow {
  return {
    google: {
      scans: row.google_scans,
      rated: row.google_rated,
      avg_rating: row.google_avg,
    },
    private: {
      scans: row.private_scans,
      rated: row.private_rated,
      avg_rating: row.private_avg,
    },
  };
}

/**
 * Per-location rollup — the pack of stickers, one row per table or zone.
 *
 * This is the query the product is sold on: "which of my tables actually
 * converts". It answers it in one pass over a shared schema rather than N
 * queries against N tenant schemas.
 *
 * `LEFT JOIN` on purpose. A scan recorded before its location was assigned, or
 * after the location was deleted, still has a row in `tag_ratings`; an inner
 * join would drop it and the per-location totals would silently disagree with
 * the tenant-wide total on the same screen. Those rows group under a null
 * location and surface as an "unassigned" row instead of vanishing.
 *
 * `public.locations` is joined for the human-readable name. It is the one place
 * the shared analytics schema reaches across to the public one, and it is safe
 * because a location id is a uuid rather than an interpolated identifier.
 */
export function buildLocationRollupQuery(tenantId: string): BoundQuery {
  return {
    text: `SELECT r.location_id,
            l.name  AS location_name,
            COUNT(*) FILTER (WHERE r.action_taken = 'google_redirect')::int   AS google_scans,
            COUNT(r.rating) FILTER (WHERE r.action_taken = 'google_redirect')::int AS google_rated,
            COUNT(*) FILTER (WHERE r.action_taken = 'internal_feedback')::int AS private_scans,
            COUNT(r.rating) FILTER (WHERE r.action_taken = 'internal_feedback')::int AS private_rated
       FROM analytics.tag_ratings r
       LEFT JOIN public.locations l ON l.id = r.location_id
      WHERE r.tenant_id = $1
      GROUP BY r.location_id, l.name
      ORDER BY (COUNT(*)) DESC, l.name ASC NULLS LAST`,
    params: [tenantId],
  };
}

/**
 * Peak traffic, bucketed into fixed one-hour epoch windows.
 *
 * Epoch division rather than `date_trunc()` for the same reason
 * `metrics.sessionBucketSql` uses it: a `date_trunc` bucket drifts with the
 * session time zone and stops meaning the same thing across two requests. Fixed
 * epoch buckets are UTC-anchored and reproducible.
 *
 * The bucket start comes back as epoch seconds rather than a formatted label so
 * the dashboard renders it in the viewer's own time zone. "14:00" means nothing
 * without knowing whose 14:00 it is.
 */
export function buildPeakTrafficQuery(tenantId: string): BoundQuery {
  return {
    text: `SELECT b.bucket,
              COUNT(*) FILTER (WHERE b.action_taken = 'google_redirect')::int   AS google,
              COUNT(*) FILTER (WHERE b.action_taken = 'internal_feedback')::int AS private
         FROM (
           SELECT (floor(extract(epoch FROM r.scanned_at)
                         / ${PEAK_BUCKET_SECONDS})
                 * ${PEAK_BUCKET_SECONDS})::bigint AS bucket,
                  r.action_taken
             FROM analytics.tag_ratings r
            WHERE r.tenant_id = $1
              AND r.scanned_at >= NOW() - CAST($2 AS interval)
         ) b
        GROUP BY b.bucket
        ORDER BY b.bucket ASC`,
    params: [tenantId, PEAK_WINDOW],
  };
}