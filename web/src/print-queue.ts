/** One link waiting to be printed. */
export type QueueItem = { id: string; short_code: string };

/**
 * THE PRINT QUEUE (odd/tasks/print-queue-cards.md S2-S3, dashboard-react T3a).
 *
 * Links sent from the Links table to the Cards section for the print at hand.
 * It lives in this module, so it is page memory: nothing is fetched or stored,
 * and a reload starts empty (print-queue-cards L3).
 *
 * The Links table and the Cards island both import this module; nothing is
 * published on window (the migration bridge, `window.__printQueue` and its
 * helpers, is gone). The server-rendered sidebar's `#cards-count` badge is
 * the one piece of the page it still writes. The array is replaced, never
 * edited in place, which is what lets React compare it by identity.
 */

let queue: readonly QueueItem[] = [];
const listeners = new Set<() => void>();

export function getPrintQueue(): readonly QueueItem[] {
  return queue;
}

/** For useSyncExternalStore: called on every change. */
export function subscribePrintQueue(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Publishes a change: the sidebar count, then the subscribers. */
function publish(next: readonly QueueItem[]) {
  queue = next;
  const badge = document.getElementById("cards-count");
  if (badge) {
    badge.textContent = String(next.length);
    badge.hidden = next.length === 0;
  }
  listeners.forEach((listener) => listener());
}

/** Adds or removes one link. Synchronous and local: no request, no reload. */
export function setPrintQueued(id: string, queued: boolean, code?: string): void {
  const present = queue.some((item) => item.id === id);
  if (queued && !present) publish([...queue, { id, short_code: code || "" }]);
  else if (!queued && present) publish(queue.filter((item) => item.id !== id));
  // Unchanged still announces, as the legacy helper did on every click.
  else publish(queue);
}

/** Empties the queue after a print run ("Mark as printed"), with no request. */
export function clearPrintQueue(): void {
  publish([]);
}

/**
 * Reconciles the queue with a fresh links list: a link that was deleted or
 * got a destination leaves the queue (print-queue-cards S3b).
 */
export function prunePrintQueue(links: ReadonlyArray<{ id: string; original_url?: string | null }>): void {
  const byId = new Map(links.map((l) => [l.id, l]));
  publish(
    queue.filter((item) => {
      const l = byId.get(item.id);
      return Boolean(l) && !l!.original_url;
    }),
  );
}
