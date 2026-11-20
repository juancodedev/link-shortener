import { act, render } from "@testing-library/react";
import { vi } from "vitest";
import { LinksSection } from "../../src/links/LinksSection";
import { clearPrintQueue, installPrintQueue } from "../../src/print-queue";

/**
 * Stands in for the server-rendered dashboard around the Links island:
 * window.__api (which, like the real one, THROWS on a non-ok response), the
 * readiness gate, and the bridges the legacy page exposes.
 */

export type Call = { method: string; path: string; body?: unknown };
export type Handler = (method: string, path: string, body?: unknown) => unknown;

export const BASE_LINK = {
  id: "link-uuid",
  short_code: "abc1234",
  short_url: "https://short.link/abc1234",
  original_url: "https://example.com" as string | null,
  title: null,
  client_ref: null as string | null,
  clicks_count: 5,
  is_active: true,
  expires_at: null as string | null,
  is_gated: false,
  location_id: null as string | null,
  location_name: null as string | null,
  business_name: null as string | null,
};

export function link(over: Record<string, unknown> = {}) {
  return { ...BASE_LINK, ...over };
}

export const CLICKS = {
  unique_visitors: 30,
  sessions: 42,
  unique_window: "1 day",
  session_window: "30 minutes",
  by_country: { CL: 3, AR: 7 },
  by_device: { mobile: 9 },
  by_source: {},
};

/** Answers through `handler`; a thrown error is what the real __api throws on a non-ok status. */
export function installApi(handler: Handler): Call[] {
  const calls: Call[] = [];
  window.__api = vi.fn(async (method: string, path: string, body?: unknown) => {
    calls.push(body === undefined ? { method, path } : { method, path, body });
    const out = await handler(method, path, body);
    if (out instanceof Response) return out;
    return new Response(JSON.stringify(out ?? {}), { status: 200 });
  });
  return calls;
}

type Routes = {
  links?: unknown[] | (() => unknown);
  clients?: unknown;
  gate?: unknown;
  clicks?: (id: string) => unknown;
  patch?: (id: string, body: unknown) => unknown;
  del?: (id: string) => unknown;
};

/** The dashboard API with sensible defaults; each route can be overridden. */
export function standardApi(routes: Routes = {}): Call[] {
  return installApi((method, path, body) => {
    if (method === "GET" && path === "/api/links") {
      return typeof routes.links === "function" ? routes.links() : (routes.links ?? [link()]);
    }
    if (method === "GET" && path === "/api/clients/metrics") return routes.clients ?? [];
    if (method === "GET" && path === "/api/review-gate/metrics") return routes.gate ?? { rated: 0 };
    const clicks = path.match(/^\/api\/links\/([^/]+)\/clicks$/);
    if (method === "GET" && clicks) return routes.clicks ? routes.clicks(clicks[1]!) : CLICKS;
    const one = path.match(/^\/api\/links\/([^/]+)$/);
    if (method === "PATCH" && one) return routes.patch ? routes.patch(one[1]!, body) : { ok: true };
    if (method === "DELETE" && one) return routes.del ? routes.del(one[1]!) : { ok: true };
    throw new Error(`unexpected ${method} ${path}`);
  });
}

export type Bridges = {
  overview: Array<Record<string, unknown>>;
  clientsRefreshed: number;
  qr: string[];
};

/** The legacy page's bridges, recorded. */
export function installLegacy(): Bridges {
  const bridges: Bridges = { overview: [], clientsRefreshed: 0, qr: [] };
  window.__apiReady = Promise.resolve();
  window.__renderOverviewCards = (cards) => bridges.overview.push(cards as Record<string, unknown>);
  window.__refreshClientsCard = () => {
    bridges.clientsRefreshed++;
  };
  window.__showQR = (url: string) => bridges.qr.push(url);
  window.__branches = undefined;
  window.__businesses = undefined;
  installPrintQueue();
  clearPrintQueue();
  return bridges;
}

/** Lets every pending request, JSON parse and React update settle. */
export async function settle() {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

export async function mountLinks(limit = 100) {
  const view = render(<LinksSection limit={limit} />);
  await settle();
  return view;
}

/** A promise and the function that releases it. */
export function gate(): { wait: Promise<void>; release: () => void } {
  let release = () => {};
  const wait = new Promise<void>((r) => {
    release = r;
  });
  return { wait, release };
}

export const panel = (id = "link-uuid") => document.getElementById(`metrics-${id}`) as HTMLTableRowElement;
export const row = (id = "link-uuid") => panel(id).previousElementSibling as HTMLTableRowElement;
export const isOpen = (id = "link-uuid") => panel(id).style.display !== "none";
export const field = (id: string) => document.getElementById(id) as HTMLInputElement & HTMLSelectElement;
export const count = (calls: Call[], method: string, path: string) =>
  calls.filter((c) => c.method === method && c.path === path).length;

/** The button with this exact text inside `root`. */
export function button(root: Element, text: string): HTMLButtonElement {
  const found = [...root.querySelectorAll("button")].find((b) => b.textContent === text);
  if (!found) throw new Error(`no "${text}" button`);
  return found;
}
