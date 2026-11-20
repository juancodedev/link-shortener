import { useSyncExternalStore } from "react";

/**
 * The tenant's businesses and branches, held once for the whole bundle
 * (dashboard-react T5).
 *
 * Three sections read them: the Businesses card lists and edits them, every
 * Links row picks a branch from them, and the Comments filter narrows the
 * inbox by them. They used to live on window.__branches/__businesses, set by
 * the legacy loadBranches and announced with a `brancheschange` event. All
 * three readers are React now and share one bundle, so a module holds the
 * lists and nothing is lent through window.
 *
 * Loaded once at boot (../dashboard.tsx) and again after every Businesses
 * action; separate from the links load, because the list changes when
 * branches are managed, not when a link is toggled.
 */

/** A branch ("sucursal") as GET /api/locations returns it. */
export type Branch = {
  id: string;
  name: string;
  business_id?: string | null;
  business_name?: string | null;
  is_active?: boolean;
  /** How many links the branch holds; shown on the Businesses card. */
  link_count?: number;
};

/** A business ("local") as GET /api/businesses returns it. */
export type Business = { id: string; name: string; is_active?: boolean };

export type BranchesState = {
  /** "error" keeps the last lists: the pickers and the filter stay usable, the card says so. */
  status: "loading" | "ready" | "error";
  branches: Branch[];
  businesses: Business[];
  /** Bumped by every successful load: the Businesses card redraws from scratch, as the legacy innerHTML did. */
  version: number;
};

const INITIAL: BranchesState = { status: "loading", branches: [], businesses: [], version: 0 };

let state = INITIAL;
let seq = 0;
const listeners = new Set<() => void>();

function set(next: BranchesState) {
  state = next;
  listeners.forEach((listener) => listener());
}

export function getBranches(): BranchesState {
  return state;
}

export function subscribeBranches(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * GET /api/locations and /api/businesses, together. Safe to call at any
 * point: it parks on window.__apiReady until the auth bootstrap defines
 * window.__api. When loads overlap, only the newest one lands.
 */
export async function loadBranches(): Promise<void> {
  const mine = ++seq;
  if (window.__apiReady) await window.__apiReady;
  try {
    const [locRes, bizRes] = await Promise.all([
      window.__api("GET", "/api/locations"),
      window.__api("GET", "/api/businesses"),
    ]);
    if (!locRes.ok) throw new Error("branches: HTTP " + locRes.status);
    if (!bizRes.ok) throw new Error("businesses: HTTP " + bizRes.status);
    const branches = ((await locRes.json()) as { locations?: Branch[] }).locations || [];
    const businesses = ((await bizRes.json()) as { businesses?: Business[] }).businesses || [];
    if (mine !== seq) return;
    set({ status: "ready", branches, businesses, version: state.version + 1 });
  } catch (err) {
    if (mine !== seq) return;
    console.error("branches failed to load", err);
    set({ ...state, status: "error" });
  }
}

/** Back to "never loaded", dropping any load in flight. For tests: the store outlives a render. */
export function resetBranches(): void {
  seq++;
  set(INITIAL);
}

/** The current lists; re-renders on every load. */
export function useBranches(): BranchesState {
  return useSyncExternalStore(subscribeBranches, getBranches);
}

/**
 * Branches that can be chosen in a picker: switched on, and not inside a
 * switched-off business. The Businesses card still lists everything, so an
 * inactive one can be switched back on. The Links pickers and the Comments
 * filter both use this one rule.
 */
export function pickableBranches(branches: Branch[], businesses: Business[]): Branch[] {
  const off = new Set(businesses.filter((b) => b.is_active === false).map((b) => b.id));
  return branches.filter((l) => l.is_active !== false && !off.has(l.business_id ?? ""));
}
