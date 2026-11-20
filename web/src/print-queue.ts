import { PRINT_QUEUE_EVENT, type QueueItem } from "./legacy";

/**
 * THE PRINT QUEUE (odd/tasks/print-queue-cards.md S2-S3, dashboard-react T3a).
 *
 * Links sent from the Links table to the Cards section for the print at hand.
 * It lives in this module, so it is page memory: nothing is fetched or stored,
 * and a reload starts empty (print-queue-cards L3).
 *
 * The queue moved here from the legacy page together with the Links table.
 * The window names it published (`__printQueue`, `__setPrintQueued`,
 * `__clearPrintQueue`, the `printqueuechange` event and the `#cards-count`
 * badge) are kept as the contract, so the Cards island reads it exactly as
 * before. The array is replaced, never edited in place, which is what lets
 * React compare it by identity.
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

/** Publishes a change: the window copy, the sidebar count, the event, the subscribers. */
function publish(next: readonly QueueItem[]) {
  queue = next;
  // A copy, so a reader that edits it cannot change the queue behind our back.
  window.__printQueue = [...next];
  const badge = document.getElementById("cards-count");
  if (badge) {
    badge.textContent = String(next.length);
    badge.hidden = next.length === 0;
  }
  window.dispatchEvent(new Event(PRINT_QUEUE_EVENT));
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

/** Lends the queue to the page under its window names. */
export function installPrintQueue(): void {
  window.__printQueue = [...queue];
  window.__setPrintQueued = setPrintQueued;
  window.__clearPrintQueue = clearPrintQueue;
}

// On load, so the contract exists before any island mounts: the registry
// imports this module (through the Links island) ahead of mountIslands().
installPrintQueue();
