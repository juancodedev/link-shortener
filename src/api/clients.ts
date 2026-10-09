import type { Handler } from "hono";
import type { AppEnv, HonoVars } from "../types/env";
import { withClient } from "../db/client";
import { qualifyTable } from "../db/schema";
import {
  buildClientRefMetricsQuery,
  toClientRefMetrics,
  type ClientRefMetricsRow,
} from "../analytics/metrics";

// ---------------------------------------------------------------------------
// GET /api/clients/metrics — the per-`client_ref` visitor rollup
//
// WHY THIS IS ITS OWN ENDPOINT
//
// This aggregate used to ride along inside `GET /api/links`, which meant
// changing that response from a bare array of links into `{ links, clients }`.
// It was a breaking change no caller asked for: every consumer written against
// the original contract received an object where it expected a collection and
// failed on it. The dashboard kept working only because it was rewritten in the
// same change, which hides the breakage from every other consumer — including
// the CRM integration this project is headed toward.
//
// So the container goes back to being an array and the rollup gets a route of
// its own. Two collection endpoints can be fetched independently, cached
// independently, and versioned independently; one endpoint cannot change shape
// without breaking half its consumers.
//
// THE NAME, DELIBERATELY
//
// The path says `clients` and the handler says `clientRefMetrics`, which is
// intentional rather than sloppy:
//
//   - `client_ref` is FREE TEXT the user types. There is no client entity in
//     this system, so `/api/clients` alone would advertise a CRUD resource that
//     does not exist and invite a consumer to POST to it. `/api/clients/metrics`
//     describes the one thing this route actually is.
//   - The export keeps `client_ref` in its name so nobody reading a call site
//     mistakes these figures for something keyed on a real client record.
//
// THE RESPONSE IS A BARE ARRAY
//
// `[{ client_ref, unique_visitors, sessions }]`. Consistent with `GET /api/links`
// and with the rest of this API, and it avoids re-creating the envelope mistake
// in a second place. The trade-off is explicit: unlike `linkClicks`, this
// response does not carry `unique_window` / `session_window` alongside the
// figures. That omission is safe HERE specifically because the dashboard renders
// no window label next to this table — `linkClicks` ships them because it does.
// The windows are fixed exported constants (`UNIQUE_WINDOW`, `SESSION_WINDOW`
// in src/analytics/metrics.ts), bound as parameters into the aggregate below.
// ---------------------------------------------------------------------------

export const listClientRefMetrics: Handler<{
  Bindings: AppEnv;
  Variables: HonoVars;
}> = async (c) => {
  const tenant = c.get("tenant");
  const table = qualifyTable(tenant.schemaName, "links");

  const rows = await withClient(c.env, async (client) => {
    // Per-store rollup (T2.4). `client_ref` is the identifier the user defines
    // per store, so this is the view that answers "how much footfall did THIS
    // shop get" without opening each link.
    //
    // It cannot be assembled by summing the per-link figures: a person who
    // scans two tags at one store is ONE visitor there, not two, and only a
    // distinct count across every link sharing the ref knows that. Hence a
    // second aggregate rather than arithmetic over per-link numbers.
    //
    // Tenant scoping comes from the inner join against THIS tenant's links
    // table: `analytics.link_clicks.link_id` has no foreign key, so that join is
    // the only thing selecting rows for one tenant. Same boundary `linkClicks`
    // relies on.
    //
    // Not wrapped in a catch. If this query fails the endpoint fails with it,
    // because the alternative — reporting zero visitors — would publish a
    // confident "nobody came in today" that is a lie. A missing panel is
    // honest; a wrong zero is not.
    const rollup = buildClientRefMetricsQuery(table);
    const res = await client.query<ClientRefMetricsRow>(rollup.text, rollup.params);

    return res.rows.map(toClientRefMetrics);
  });

  return c.json(rows);
};