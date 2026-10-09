// ---------------------------------------------------------------------------
// Phase 2 — unique visitors and sessions.
//
// WHAT THESE NUMBERS ARE, AND WHAT THEY ARE NOT
//
// `analytics.link_clicks.ip_hash` is SHA-256(ip + per-tenant salt): a stable,
// deterministic per-tenant identifier. The same person scanning tomorrow
// produces the same hash, so COUNT(DISTINCT ip_hash) is meaningful without a
// cookie, a consent banner, or any first-party identifier. It is also a
// persistent pseudonymous identifier, which is why it must never be exposed to
// a client or joined against another dataset.
//
// THE CEILING IS STRUCTURAL, NOT A BUG IN THIS FILE
//
// Both figures below are a PESSIMISTIC LOWER BOUND on real people, and no
// amount of work on this module removes that:
//
//   * a cafe on shared Wi-Fi sends 40 people through one public IP -> count 1
//   * a phone on a carrier behind CGNAT shares an IP with many subscribers
//
// There is no signal in the row that distinguishes "one person tapping their
// tag three times" from "three people sharing a hotel lobby NAT". Choosing
// otherwise means storing a cookie, and the feature scope explicitly refuses
// that trade. So the caveat travels WITH the metric: it is stated here at the
// point of definition, and again in the rendered dashboard markup beside the
// numbers, because a store owner reading "42 unique visitors" will make a
// decision with it.
//
// A "unique visitors" figure shown without that caveat next to it is worse
// than showing no figure at all.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

/**
 * Rolling horizon for `unique_visitors`: "how many distinct people came back
 * in the last day".
 *
 * Also the horizon over which `sessions` is tallied, so the two figures answer
 * the same question at two granularities and can be read side by side. A
 * lifetime unique count next to a lifetime session count would be two
 * different questions wearing one label.
 */
export const UNIQUE_WINDOW = "1 day";

/**
 * Width of one session bucket: a person tapping the same tag three times in a
 * row is one visit, not three.
 *
 * This is the figure that tracks a real store better than the daily unique,
 * because a lunch rush genuinely is ~30 distinct people rather than 1 — the
 * 30-minute slice separates them even when the underlying network does not.
 */
export const SESSION_WINDOW = "30 minutes";

/**
 * The caveat, as one exported string, so the sentence that qualifies these
 * numbers cannot drift from the numbers themselves.
 *
 * The dashboard interpolates this into server-rendered markup beside the
 * figures. That is deliberate: a caveat delivered by a tooltip, a README, or a
 * JS string the user has to expand a panel to reveal is a caveat nobody reads,
 * and the store owner who acts on "42 unique visitors" never saw it. Static
 * markup is visible the moment the page loads.
 *
 * Kept adjacent to the window constants on purpose — the limitation belongs to
 * the metric, not to a documentation file that no one opens.
 */
export const VISITOR_ESTIMATE_CAVEAT =
  "Estimates, not exact counts. Visitors are identified by a salted hash of their IP " +
  "address, so people on the same Wi-Fi or mobile network are counted as one visitor. " +
  "Both figures UNDER-report real footfall.";

/**
 * The floor for a fixed-width bucket, in epoch seconds.
 *
 * Chosen as an epoch division rather than `date_bin()` on purpose:
 *
 *   - `date_bin()` needs PostgreSQL 14+, and the deployed major version cannot
 *     be verified from this repository, so it would be an unverifiable
 *     dependency for no gain. Epoch division is exact on every version.
 *   - Fixed-width epoch buckets are UTC-anchored and reproducible. A
 *     `to_char()` / `date_trunc()` string bucket would drift with the session
 *     time zone and stop meaning anything across two requests.
 *
 * `floor` means a click landing exactly on a boundary belongs to the LATER
 * bucket. That is a choice, not an accident: at the boundary the person is
 * demonstrably still with us, so the bucket should still be open.
 *
 * The stride placeholder is passed in rather than baked in because the two
 * queries bind their windows at different positions — hardcoding `$3` here
 * silently produced an unbound placeholder in the rollup, which Postgres
 * rejects at runtime rather than at build time.
 */
function sessionBucketSql(strideParam: string): string {
  return `
         (floor(extract(epoch FROM c.created_at)
                / extract(epoch FROM CAST(${strideParam} AS interval)))
          * extract(epoch FROM CAST(${strideParam} AS interval)))::bigint`;
}

// ---------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------

/**
 * The two visitor figures, as returned by Postgres.
 *
 * `pg` returns COUNT as a bigint and the driver may hand it back as a string,
 * so both are typed as `number | string` and coerced at the boundary — the
 * same defensive shape `ClickGroupRow.count` already uses in `api/links.ts`.
 */
export interface VisitorMetricsRow {
  unique_visitors: number | string;
  sessions: number | string;
}

/** One row of the per-`client_ref` rollup. */
export interface ClientRefMetricsRow {
  client_ref: string;
  unique_visitors: number | string;
  sessions: number | string;
}

/** A rollup row after coercion, as the API returns it. */
export interface ClientRefMetrics {
  client_ref: string;
  unique_visitors: number;
  sessions: number;
}

/** A query with its bind parameters, so constants are never interpolated. */
export interface BoundQuery {
  text: string;
  params: unknown[];
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * Visitor figures for ONE link.
 *
 * Both figures come out of a single pass over a de-duplicated derived table:
 *
 *   SELECT DISTINCT ip_hash, <30-minute bucket>
 *
 * That derived table is the whole trick. Deduplicating on the PAIR means:
 *
 *   - COUNT(DISTINCT ip_hash) over it is the daily unique count.
 *   - COUNT(*) over it is the session count, because each surviving row is one
 *     person in one bucket — a person's second and third taps in the same half
 *     hour collapse onto the row their first tap already produced.
 *
 * Doing it in one query rather than two also means the aggregate never sees
 * raw rows: the pre-Phase-0 defect counted a `LIMIT 50` sample and reported
 * `total: rows.length`, and folding buckets in JavaScript would reintroduce
 * that class of bug with extra steps.
 *
 * `ip_hash IS NOT NULL` is required, not decorative. COUNT(DISTINCT) already
 * ignores nulls, but the session figure is a COUNT(*), so without this filter a
 * click with no resolvable IP would be counted as a person and silently inflate
 * the number of visitors who walked in.
 */
export function buildLinkVisitorMetricsQuery(linkId: string): BoundQuery {
  return {
    text: `SELECT COUNT(DISTINCT s.ip_hash)::int AS unique_visitors,
            COUNT(*)::int                  AS sessions
       FROM (
         SELECT DISTINCT
                c.ip_hash,${sessionBucketSql("$3")} AS session_bucket
           FROM analytics.link_clicks c
          WHERE c.link_id = $1
            AND c.created_at >= NOW() - CAST($2 AS interval)
            AND c.ip_hash IS NOT NULL
       ) s`,
    params: [linkId, UNIQUE_WINDOW, SESSION_WINDOW],
  };
}

/**
 * The same two figures rolled up per `client_ref` — the per-store identifier.
 *
 * The distinction that matters: at the LINK level a person who scans two tags
 * in one shop is one visitor on each link and two visits. At the STORE level
 * they are one visitor and, if the two scans share a 30-minute bucket, one
 * session. Only the rollup can express that, which is why this cannot be
 * assembled by summing per-link figures in JavaScript.
 *
 * `client_ref IS NOT NULL` keeps un-identified links out of the rollup; they
 * are still counted in full by `linkClicks`. Links with no matching clicks
 * simply produce no row — the rollup reports stores that had traffic, not every
 * store that exists.
 *
 * Tenant isolation is inherited from the join: `analytics.link_clicks.link_id`
 * has no foreign key (links live in per-tenant schemas), so the only thing that
 * scopes this query to one tenant is the inner join against THIS tenant's
 * links table. That is the same boundary `linkClicks` relies on.
 */
export function buildClientRefMetricsQuery(linksTable: string): BoundQuery {
  return {
    text: `SELECT s.client_ref,
            COUNT(DISTINCT s.ip_hash)::int AS unique_visitors,
            COUNT(*)::int                 AS sessions
       FROM (
         SELECT DISTINCT
                l.client_ref,
                c.ip_hash,${sessionBucketSql("$2")} AS session_bucket
           FROM ${linksTable} l
           JOIN analytics.link_clicks c ON c.link_id = l.id
          WHERE l.client_ref IS NOT NULL
            AND c.created_at >= NOW() - CAST($1 AS interval)
            AND c.ip_hash IS NOT NULL
       ) s
      GROUP BY s.client_ref
      ORDER BY sessions DESC, s.client_ref ASC`,
    params: [UNIQUE_WINDOW, SESSION_WINDOW],
  };
}

/**
 * Coerces a driver-returned COUNT into a number.
 *
 * Postgres hands COUNT back as bigint; depending on driver and type parser it
 * may arrive as a string, and string `+` would concatenate rather than add.
 */
export function toCount(value: number | string): number {
  return Number(value);
}

/** Coerces one rollup row, leaving the identifier as the driver returned it. */
export function toClientRefMetrics(row: ClientRefMetricsRow): ClientRefMetrics {
  return {
    client_ref: row.client_ref,
    unique_visitors: toCount(row.unique_visitors),
    sessions: toCount(row.sessions),
  };
}