/**
 * What the Links island tells the Overview island (dashboard-react T4, L13).
 *
 * Each section fetches its own data now, but two Overview cards summarise the
 * links: the review-gate panel and the client_ref rollup. They used to be
 * repainted by every Links load, and the rollup again after a client_ref
 * save, so they stayed in step with the table. These signals keep that
 * freshness without coupling the loads: Links says what changed, and the
 * Overview refetches only the cards that depend on it.
 *
 * In-bundle on purpose: both islands live in the same bundle, so a module
 * holds the listeners and nothing is lent through window.
 */
export type OverviewChange =
  /** The links table loaded again: the gate panel and the rollup may have moved. */
  | "links"
  /** A link's client_ref was saved: the rollup regroups, nothing else changes. */
  | "client-ref";

const listeners = new Set<(change: OverviewChange) => void>();

export function announceOverviewChange(change: OverviewChange): void {
  listeners.forEach((listener) => listener(change));
}

/** Subscribes to every change; returns the unsubscribe. */
export function onOverviewChange(listener: (change: OverviewChange) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
