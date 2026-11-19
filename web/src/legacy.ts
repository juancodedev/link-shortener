/**
 * What the server-rendered dashboard (src/handlers/dashboard.ts) exposes to
 * the React islands while sections migrate one by one
 * (odd/tasks/dashboard-react.md S2). The Links table still owns the print
 * queue, so islands read it and change it only through these helpers.
 */
export type QueueItem = { id: string; short_code: string };

declare global {
  interface Window {
    /** Authenticated fetch: Bearer token, tenant header, 401 → /login. */
    __api: (method: string, path: string, body?: unknown) => Promise<Response>;
    /** Links waiting to be printed; page state, empty on reload. */
    __printQueue: QueueItem[];
    /** Adds or removes one link, updating its row in the Links table. */
    __setPrintQueued: (id: string, queued: boolean, code?: string) => void;
    /** Empties the queue after a print run and resets every queued row. */
    __clearPrintQueue: () => void;
  }
}

/** Fired on window whenever the print queue changes. */
export const PRINT_QUEUE_EVENT = "printqueuechange";
