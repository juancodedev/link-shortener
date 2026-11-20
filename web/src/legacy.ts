/**
 * What the server-rendered dashboard (src/handlers/dashboard.ts) and the React
 * islands lend each other while sections migrate one by one
 * (odd/tasks/dashboard-react.md S2). The print queue is owned by the React
 * bundle (./print-queue) since the Links table moved (T3a); the window names
 * below stay the contract, so the Cards island and any remaining legacy code
 * keep reading it the same way.
 */
export type QueueItem = { id: string; short_code: string };

declare global {
  interface Window {
    /** Authenticated fetch: Bearer token, tenant header, 401 → /login. Throws on any non-ok response. */
    __api: (method: string, path: string, body?: unknown) => Promise<Response>;
    /** Resolved by the auth bootstrap once window.__api exists. */
    __apiReady?: Promise<void>;
    /** Links waiting to be printed (a copy; page state, empty on reload). */
    __printQueue: QueueItem[];
    /** Adds or removes one link from the print queue. */
    __setPrintQueued: (id: string, queued: boolean, code?: string) => void;
    /** Empties the queue after a print run. */
    __clearPrintQueue: () => void;
  }
}

/** Fired on window whenever the print queue changes. */
export const PRINT_QUEUE_EVENT = "printqueuechange";
