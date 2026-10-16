import type { Handler } from "hono";
import type { AppEnv, HonoVars } from "../types/env";
import { withClient } from "../db/client";
import {
  MIN_RATED_SAMPLE,
  PEAK_WINDOW,
  buildActionSplitQuery,
  buildLocationRollupQuery,
  buildPeakTrafficQuery,
  splitRows,
  toActionSplit,
  toLocationRollup,
  toPeakBucket,
  type LocationRollup,
  type PeakBucket,
} from "../analytics/review-gate";
import { toCsv } from "../utils/csv";
import { qualifyTable } from "../db/schema";
import { isUuid } from "../utils/validation";

// ---------------------------------------------------------------------------
// GET /api/review-gate/metrics
//
// The panel's three views: the action split, the per-location rollup, and the
// hourly peaks.
//
// WHY ONE RESPONSE RATHER THAN THREE ROUTES
//
// The three views describe the same scans and the dashboard renders them side by
// side on one screen. Three independent fetches would let the derivation rate on
// the left and the peak chart on the right describe slightly different moments —
// the numbers would disagree in front of the owner and neither would be obviously
// wrong. `GET /api/links` and `GET /api/clients/metrics` are separate because
// they are separate concerns that change at separate times; these three are one
// reading of one table.
//
// NOT CAUGHT, ON PURPOSE
//
// A database failure propagates and the endpoint 500s. The alternative —
// returning empty collections — would render a panel reading "0 scans today,
// 0% derivation" at a moment when the database is unreachable. A missing panel
// is honest. A confident zero is not, and the owner makes staffing decisions off
// this screen.
//
// `MIN_RATED_SAMPLE` ships in the response rather than being duplicated in the
// dashboard's markup: the label that says "sample too small" depends on that
// number, and a hardcoded copy on the client drifts the first time the constant
// moves.
// ---------------------------------------------------------------------------

export const reviewGateMetrics: Handler<{
  Bindings: AppEnv;
  Variables: HonoVars;
}> = async (c) => {
  const tenant = c.get("tenant");

  const result = await withClient(c.env, async (client) => {
    const splitQ = buildActionSplitQuery(tenant.tenantId);
    const splitRes = await client.query(splitQ.text, splitQ.params);

    const locQ = buildLocationRollupQuery(tenant.tenantId);
    const locRes = await client.query(locQ.text, locQ.params);

    const peakQ = buildPeakTrafficQuery(tenant.tenantId);
    const peakRes = await client.query(peakQ.text, peakQ.params);

    // No rows at all means the tenant has never had a gated scan. An empty
    // aggregate still yields a well-formed split of zeros, which is a truthful
    // "nothing yet" rather than a missing field.
    const splitRow = splitRes.rows[0] ?? {
      google_scans: 0,
      google_rated: 0,
      google_avg: null,
      private_scans: 0,
      private_rated: 0,
      private_avg: null,
    };

    return {
      split: splitRow,
      locations: locRes.rows.map(toLocationRollup),
      peaks: peakRes.rows.map(toPeakBucket),
    };
  });

  return c.json({
    split: toActionSplit(splitRows(result.split)),
    locations: result.locations as LocationRollup[],
    peaks: result.peaks as PeakBucket[],
    meta: {
      minRatedSample: MIN_RATED_SAMPLE,
      peakWindow: PEAK_WINDOW,
      peakBucketSeconds: 3600,
    },
  });
};

// ---------------------------------------------------------------------------
// The inbox: what customers actually wrote
//
// The metrics endpoint above answers "how many people were satisfied", which is
// an aggregate. It returns aggregates only — no endpoint anywhere displayed the
// text of a single comment, and seven real ones existed in production while the
// owner had no way to read a single one of them.
//
// Collecting a message and never showing it to anyone is the worst outcome a
// feedback feature can have: the customer believed they had been heard, the
// owner believed nobody had written anything, and the truth sat in a table.
//
// ---------------------------------------------------------------------------

/** How many comments the list returns. */
export const FEEDBACK_PAGE_SIZE = 100;

/** How many the export writes. Bounded because the CSV is built in memory. */
export const FEEDBACK_EXPORT_LIMIT = 2000;

export interface FeedbackRow {
  id: string;
  comment: string;
  rating: number | null;
  customer_contact: string | null;
  scanned_at: string;
  short_code: string | null;
  client_ref: string | null;
  location_name: string | null;
}

interface FeedbackFilters {
  locationId?: string;
  since?: string;
}

/**
 * The feedback query, newest first.
 *
 * Newest-first always, not as a sort option: an inbox that leads with its oldest
 * entry is a backlog, and a comment from four months ago does not outrank one
 * from this morning.
 *
 * Every row carries its table. A comment with no location is a sentence with no
 * context, and the location is the only thing telling the owner what to do
 * about it.
 *
 * `f.rating` and the link are LEFT JOINED because a comment can be left with no
 * rating and, if the link was deleted meanwhile, with no parent row at all.
 * Neither should make a customer's words disappear.
 */
function buildFeedbackQuery(
  tenantId: string,
  schemaName: string,
  filters: FeedbackFilters,
  limit: number,
) {
  const clauses = ["f.tenant_id = $1"];
  const params: unknown[] = [tenantId];

  // The tenant's links live in its own schema, named `tenant_xxxxxxxx` — not by
  // tenant id. Interpolated rather than parameterised because a schema name
  // cannot be a bind parameter, and it is NOT user input: it comes from the
  // registry row the tenant was resolved to.
  const linksTable = qualifyTable(schemaName, "links");

  if (filters.locationId) {
    params.push(filters.locationId);
    clauses.push(`f.location_id = $${params.length}`);
  }
  if (filters.since) {
    params.push(filters.since);
    clauses.push(`f.scanned_at >= $${params.length}`);
  }
  params.push(limit);

  return {
    text: `
      SELECT f.id, f.comment, f.rating, f.customer_contact, f.scanned_at,
             l.short_code, l.client_ref, loc.name AS location_name
        FROM analytics.tag_feedback f
        LEFT JOIN ${linksTable} l ON l.id = f.link_id
        LEFT JOIN public.locations loc ON loc.id = f.location_id
       WHERE ${clauses.join(" AND ")}
       ORDER BY f.scanned_at DESC, f.id DESC
       LIMIT $${params.length}`,
    params,
  };
}

function toFeedbackRow(row: Record<string, unknown>): FeedbackRow {
  return {
    id: String(row.id),
    // The full text, in both the list and the export. Shortening a long comment
    // is a presentation choice, so it belongs to whoever draws the row; cut here
    // and the owner could never read the end of what a customer wrote.
    comment: String(row.comment ?? ""),
    rating: row.rating === null || row.rating === undefined ? null : Number(row.rating),
    customer_contact: row.customer_contact === null ? null : String(row.customer_contact),
    // The driver hands timestamptz back as a Date. String() on a Date drops
    // the milliseconds, so it is used as is; only a string is parsed.
    scanned_at: (row.scanned_at instanceof Date
      ? row.scanned_at
      : new Date(String(row.scanned_at))
    ).toISOString(),
    short_code: row.short_code === null ? null : String(row.short_code),
    client_ref: row.client_ref === null ? null : String(row.client_ref),
    location_name: row.location_name === null ? null : String(row.location_name),
  };
}

const SINCE_MIN_YEAR = 2000;
const SINCE_MAX_YEAR = 9999;

type FilterResult =
  | { ok: true; filters: FeedbackFilters }
  | { ok: false; error: "invalid_location_id" | "invalid_since" };

/**
 * Reads and validates the list's filters.
 *
 * Both are checked HERE, before a connection is opened, rather than handed to
 * Postgres to reject. They are bind parameters, so this is not about injection:
 * a malformed uuid or date bound to a typed column is a cast error, which
 * surfaces as a 500 — "the server broke" for what is plainly a bad request,
 * and a database round trip spent learning it.
 *
 * `since` is normalised to ISO 8601 so the database receives one unambiguous
 * format whatever the caller sent. `Date` is lenient about what it parses, but
 * it does reject what it cannot read (`2026-13-45`, `yesterday`), and that is
 * the line that matters: anything it accepts names a real instant.
 */
function readFilters(url: URL): FilterResult {
  const locationId = url.searchParams.get("location_id") || undefined;
  const sinceRaw = url.searchParams.get("since") || undefined;

  if (locationId !== undefined && !isUuid(locationId)) {
    return { ok: false, error: "invalid_location_id" };
  }

  let since: string | undefined;
  if (sinceRaw !== undefined) {
    const parsed = new Date(sinceRaw);
    if (Number.isNaN(parsed.getTime())) return { ok: false, error: "invalid_since" };
    // Bounded to four-digit years. Outside them toISOString emits a signed
    // six-digit year (`+010000-01-01`), which is not a date anyone meant and
    // not a format worth betting the database parses the same way.
    const year = parsed.getUTCFullYear();
    if (year < SINCE_MIN_YEAR || year > SINCE_MAX_YEAR) {
      return { ok: false, error: "invalid_since" };
    }
    since = parsed.toISOString();
  }

  return { ok: true, filters: { locationId, since } };
}

/**
 * Runs the feedback query for at most `limit` rows, and says whether there
 * were more.
 *
 * Asks for one row past the cap. Comparing `rows.length >= limit` instead
 * would call an inbox of exactly `limit` comments truncated — telling the owner
 * there is more when there is not, which is the same lie in the other
 * direction.
 */
async function fetchFeedback(
  env: AppEnv,
  tenantId: string,
  schemaName: string,
  filters: FeedbackFilters,
  limit: number,
): Promise<{ rows: FeedbackRow[]; truncated: boolean }> {
  const rows = await withClient(env, async (client) => {
    const q = buildFeedbackQuery(tenantId, schemaName, filters, limit + 1);
    const res = await client.query(q.text, q.params);
    return res.rows as Record<string, unknown>[];
  });
  return {
    rows: rows.slice(0, limit).map(toFeedbackRow),
    truncated: rows.length > limit,
  };
}

export const listFeedback: Handler<{
  Bindings: AppEnv;
  Variables: HonoVars;
}> = async (c) => {
  const tenant = c.get("tenant");
  if (!tenant) return c.json({ error: "unauthenticated" }, 401);

  const read = readFilters(new URL(c.req.url));
  if (!read.ok) return c.json({ error: read.error }, 400);

  const { rows, truncated } = await fetchFeedback(
    c.env,
    tenant.tenantId,
    tenant.schemaName,
    read.filters,
    FEEDBACK_PAGE_SIZE,
  );

  // `truncated` is reported rather than applied silently. A cap the caller
  // cannot see is a lie about completeness: the owner counts twenty comments and
  // concludes that is all there is.
  return c.json({
    feedback: rows,
    truncated,
    limit: FEEDBACK_PAGE_SIZE,
  });
};

export const exportFeedbackCsv: Handler<{
  Bindings: AppEnv;
  Variables: HonoVars;
}> = async (c) => {
  const tenant = c.get("tenant");
  if (!tenant) return c.json({ error: "unauthenticated" }, 401);

  const read = readFilters(new URL(c.req.url));
  if (!read.ok) return c.json({ error: read.error }, 400);

  const { rows, truncated } = await fetchFeedback(
    c.env,
    tenant.tenantId,
    tenant.schemaName,
    read.filters,
    FEEDBACK_EXPORT_LIMIT,
  );

  const body = toCsv(
    ["scanned_at", "location", "client_ref", "short_code", "rating", "customer_contact", "comment"],
    rows.map((row) => [
      row.scanned_at,
      row.location_name ?? "",
      row.client_ref ?? "",
      row.short_code ?? "",
      row.rating === null ? "" : String(row.rating),
      row.customer_contact ?? "",
      row.comment,
    ]),
  );

  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      // A download link cannot be `no-store` and still be useful on reload, but
      // this file holds what customers wrote. It must not sit in a shared cache
      // for anyone but the owner who asked for it.
      "Cache-Control": "private, no-store",
      "Content-Disposition": 'attachment; filename="customer-feedback.csv"',
      // The list says `truncated` in its body; a CSV has no body to say it in
      // without corrupting the data, so the export says it here. Always sent,
      // "false" included, so a client can tell "complete" from "not reported".
      "X-Truncated": String(truncated),
      "X-Feedback-Limit": String(FEEDBACK_EXPORT_LIMIT),
    },
  });
};
