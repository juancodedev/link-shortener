import type { Handler } from "hono";
import type { AppEnv, HonoVars } from "../types/env";
import { withClient } from "../db/client";
import {
  BUSINESS_TIME_ZONE,
  HOURLY_WINDOW,
  buildHourlyTrafficQuery,
  toHourlyHistogram,
  type HourlyTrafficRow,
} from "../analytics/metrics";

// ---------------------------------------------------------------------------
// GET /api/traffic/hourly — scans per hour of the day
//
// Response: `{ time_zone, window, hours: [{ hour, scans }] }`, always 24 hours.
// Unlike `/api/clients/metrics` it carries its window and time zone, because
// the dashboard prints both under the chart: "busy at 13:00" means nothing
// without saying whose 13:00 and over which period.
//
// Not wrapped in a catch, for the same reason as the client rollup: a failed
// query must fail the request, not report a confident "nobody came".
// ---------------------------------------------------------------------------

export const hourlyTraffic: Handler<{
  Bindings: AppEnv;
  Variables: HonoVars;
}> = async (c) => {
  const tenant = c.get("tenant");

  const hours = await withClient(c.env, async (client) => {
    const q = buildHourlyTrafficQuery(tenant.tenantId);
    const res = await client.query<HourlyTrafficRow>(q.text, q.params);
    return toHourlyHistogram(res.rows);
  });

  return c.json({ time_zone: BUSINESS_TIME_ZONE, window: HOURLY_WINDOW, hours });
};
