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
