import { api } from "../api";

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
  /** The last print run that produced this card, or null if it never was. */
  printed_at?: string | null;
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

/**
 * One load of the Links section: the links, and only the links.
 *
 * The client_ref rollup and the review-gate panel used to ride on this load,
 * all-or-nothing, so the table and the Overview cards arrived in one paint
 * (L9). They are the Overview island's own loads now (L13): a failing rollup
 * no longer takes the table down with it.
 */
export async function fetchLinks(): Promise<Link[]> {
  const res = await api("GET", "/api/links");
  if (!res || !res.ok) throw new Error("Failed to load links");

  const links: unknown = await res.json();
  // An array is the documented contract for /api/links. If that ever changes
  // again the dashboard says so rather than rendering an empty table that
  // looks like "you have no links".
  if (!Array.isArray(links)) throw new Error("Unexpected /api/links response shape");
  return links as Link[];
}

/** The message a refused request carries, as the legacy alerts showed it. */
export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : "";
}
