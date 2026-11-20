/**
 * What the server-rendered dashboard (src/handlers/dashboard.ts) and the React
 * islands lend each other while sections migrate one by one
 * (odd/tasks/dashboard-react.md S2). The print queue is owned by the React
 * bundle (./print-queue) since the Links table moved (T3a); the window names
 * below stay the contract, so the Cards island and any remaining legacy code
 * keep reading it the same way.
 */
export type QueueItem = { id: string; short_code: string };

/** A branch ("sucursal") as GET /api/locations returns it. */
export type Branch = {
  id: string;
  name: string;
  business_id?: string | null;
  business_name?: string | null;
  is_active?: boolean;
};

/** A business ("local") as GET /api/businesses returns it. */
export type Business = { id: string; name: string; is_active?: boolean };

/** What the Links island hands the legacy Overview renderers (L9). */
export type OverviewCards = {
  /** Hide the gate and clients cards: a first load is starting. */
  hide?: boolean;
  /** The review-gate payload, painted by the legacy renderGatePanel. */
  gate?: unknown;
  /** The client_ref rollup, painted by the legacy renderClients. */
  clients?: unknown[];
};

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
    /** Reloads the Links table; set by the Links island while it is mounted, for the legacy refreshOwnership. */
    __loadLinks?: () => Promise<void>;
    /** Legacy: paints the Overview's gate and clients cards from the Links load. */
    __renderOverviewCards?: (cards: OverviewCards) => void;
    /** Legacy: refetches and repaints the client_ref rollup. */
    __refreshClientsCard?: () => void;
    /** Legacy: the tenant's branches and businesses, set by loadBranches. */
    __branches?: Branch[];
    __businesses?: Business[];
  }
}

/** Fired on window whenever the print queue changes. */
export const PRINT_QUEUE_EVENT = "printqueuechange";

/** Fired on window by the legacy loadBranches once __branches/__businesses are set. */
export const BRANCHES_EVENT = "brancheschange";
