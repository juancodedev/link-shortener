/** A link as GET /api/links returns it (the fields the table reads). */
export type Link = {
  id: string;
  short_code: string;
  short_url?: string | null;
  original_url?: string | null;
  client_ref?: string | null;
  clicks_count?: number;
  is_active?: boolean;
  expires_at?: string | null;
  is_gated?: boolean;
  location_id?: string | null;
  location_name?: string | null;
  business_name?: string | null;
};

/** GET /api/links/:id/clicks. */
export type ClickMetrics = {
  unique_visitors?: number;
  sessions?: number;
  unique_window?: string;
  session_window?: string;
  by_country?: Record<string, number>;
  by_device?: Record<string, number>;
  by_source?: Record<string, number>;
  error?: string;
};

export type LinksLoad = { links: Link[]; clients: unknown[] };

/**
 * One load of the Links section: the links, the client_ref rollup and the
 * review-gate panel, fetched together so the table and the Overview cards
 * arrive in one paint (dashboard-react L9: kept all-or-nothing on purpose).
 *
 * A failure of the links OR the rollup fails the load, because a
 * half-rendered dashboard is harder to trust than an error message.
 *
 * The gate panel is the exception: a tenant who has never activated a gated
 * link has no rows, and failing the whole dashboard over an empty panel would
 * be wrong, so it degrades to hidden. window.__api throws on any non-ok
 * status, so its request is caught on its own: inside Promise.all an
 * uncaught gate error would have failed the links too. `onGate` gets the
 * payload only when it could be read.
 */
export async function fetchLinks(onGate: (gate: unknown) => void): Promise<LinksLoad> {
  const [linksRes, clientsRes, gateRes] = await Promise.all([
    window.__api("GET", "/api/links"),
    window.__api("GET", "/api/clients/metrics"),
    window.__api("GET", "/api/review-gate/metrics").catch((err: unknown) => {
      console.error("gate panel failed to load", err);
      return null;
    }),
  ]);
  if (!linksRes || !linksRes.ok) throw new Error("Failed to load links");
  if (!clientsRes || !clientsRes.ok) throw new Error("Failed to load client metrics");

  if (gateRes && gateRes.ok) {
    try {
      onGate(await gateRes.json());
    } catch (err) {
      console.error("gate panel failed to render", err);
    }
  }

  const links: unknown = await linksRes.json();
  // An array is the documented contract for /api/links. If that ever changes
  // again the dashboard says so rather than rendering an empty table that
  // looks like "you have no links".
  if (!Array.isArray(links)) throw new Error("Unexpected /api/links response shape");

  // The rollup degrades to nothing rather than failing: an empty list is its
  // own honest meaning ("no store has recorded traffic").
  const clients: unknown = await clientsRes.json();
  return { links: links as Link[], clients: Array.isArray(clients) ? clients : [] };
}

/** The message a refused request carries, as the legacy alerts showed it. */
export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : "";
}
