/**
 * Reloads the Links table from outside the Links island (dashboard-react T5).
 *
 * Two other sections change what the table shows: Cards records a print run
 * (each row's printed_at), and Businesses renames, moves or switches off the
 * branches the rows name. They used to reach the table through
 * window.__loadLinks; every caller lives in this bundle now, so this module
 * holds the island's load instead, like ../overview/changes does for the
 * Overview.
 */
const loads = new Set<() => Promise<void>>();

/** Runs the mounted table's load; resolves once it has landed. Nothing mounted, nothing to do. */
export async function reloadLinks(): Promise<void> {
  await Promise.all([...loads].map((load) => load()));
}

/** Called by the Links island with its load; returns the unregister. */
export function provideLinksLoad(load: () => Promise<void>): () => void {
  loads.add(load);
  return () => {
    loads.delete(load);
  };
}
