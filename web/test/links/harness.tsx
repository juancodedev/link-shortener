import { act, render } from "@testing-library/react";
import { vi } from "vitest";
import { loadBranches, resetBranches, type Branch, type Business } from "../../src/branches/store";
import { LinksSection } from "../../src/links/LinksSection";
import { onOverviewChange, type OverviewChange } from "../../src/overview/changes";
import { clearPrintQueue } from "../../src/print-queue";
import { stubApi, stubApiReady, stubbedApi, stubbedApiReady } from "../api-stub";

/**
 * Stands in for the server-rendered dashboard around the Links island:
 * the API helper (stubbed through ../api-stub; like the real one it THROWS
 * on a non-ok response), its readiness gate, and the bridges the page
 * exposes. The changes the island announces to the Overview island are
 * recorded too. The in-bundle
 * stores (branches, print queue) are reset, since they outlive a render.
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

/** Answers through `handler`; a thrown error is what the real api() throws on a non-ok status. */
export function installApi(handler: Handler): Call[] {
  const calls: Call[] = [];
  stubApi(vi.fn(async (method: string, path: string, body?: unknown) => {
    calls.push(body === undefined ? { method, path } : { method, path, body });
    const out = await handler(method, path, body);
    if (out instanceof Response) return out;
    return new Response(JSON.stringify(out ?? {}), { status: 200 });
  }));
  return calls;
}

type Routes = {
  links?: unknown[] | (() => unknown);
  clicks?: (id: string) => unknown;
  patch?: (id: string, body: unknown) => unknown;
  del?: (id: string) => unknown;
  /** POST /api/links (the create form). */
  create?: (body: unknown) => unknown;
  /** POST /api/links/batch (bulk cards). */
  batch?: (body: unknown) => unknown;
  /** POST /api/links/qr-sheet.zip (the bulk print sheet). */
  sheet?: (body: unknown) => unknown;
};

/** The dashboard API with sensible defaults; each route can be overridden. */
export function standardApi(routes: Routes = {}): Call[] {
  return installApi((method, path, body) => {
    if (method === "GET" && path === "/api/links") {
      return typeof routes.links === "function" ? routes.links() : (routes.links ?? [link()]);
    }
    if (method === "POST" && path === "/api/links") {
      if (routes.create) return routes.create(body);
      const sent = body as { original_url?: string };
      return link({ id: "new-id", short_code: "new1234", short_url: "https://short.link/new1234", original_url: sent.original_url ?? null });
    }
    if (method === "POST" && path === "/api/links/batch") {
      if (routes.batch) return routes.batch(body);
      const items = (body as { links: unknown[] }).links;
      return { results: items.map((_, i) => ({ status: 201, link: link({ id: `bulk-${i}` }) })) };
    }
    if (method === "POST" && path === "/api/links/qr-sheet.zip") {
      return routes.sheet ? routes.sheet(body) : new Response("zip", { status: 200, headers: { "Content-Type": "application/zip" } });
    }
    const clicks = path.match(/^\/api\/links\/([^/]+)\/clicks$/);
    if (method === "GET" && clicks) return routes.clicks ? routes.clicks(clicks[1]!) : CLICKS;
    const one = path.match(/^\/api\/links\/([^/]+)$/);
    if (method === "PATCH" && one) return routes.patch ? routes.patch(one[1]!, body) : { ok: true };
    if (method === "DELETE" && one) return routes.del ? routes.del(one[1]!) : { ok: true };
    throw new Error(`unexpected ${method} ${path}`);
  });
}

export type Bridges = {
  /** Every change announced to the Overview island, in order. */
  overview: OverviewChange[];
};

let stopRecording = () => {};

/** A clean print queue and branches store, and the Overview changes, recorded. */
export function installLegacy(): Bridges {
  const bridges: Bridges = { overview: [] };
  stubApiReady(Promise.resolve());
  stopRecording();
  stopRecording = onOverviewChange((change) => bridges.overview.push(change));
  resetBranches();
  clearPrintQueue();
  return bridges;
}

/**
 * Fills the branches store through its real load, answering only its two
 * requests, then puts the test's own API stub back.
 */
export async function provideBranches(branches: Branch[], businesses: Business[]): Promise<void> {
  const previous = stubbedApi();
  const ready = stubbedApiReady();
  stubApiReady(Promise.resolve());
  installApi((method, path) => {
    if (method === "GET" && path === "/api/locations") return { locations: branches };
    if (method === "GET" && path === "/api/businesses") return { businesses };
    throw new Error(`unexpected ${method} ${path}`);
  });
  await act(async () => {
    await loadBranches();
  });
  stubApi(previous);
  stubApiReady(ready);
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

/** A stand-in for navigator.clipboard (jsdom has none); `refuse` makes writeText reject. */
export function installClipboard(refuse = false): string[] {
  const written: string[] = [];
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: vi.fn(async (text: string) => {
        if (refuse) throw new Error("denied");
        written.push(text);
      }),
    },
  });
  return written;
}

/** The button with this exact text inside `root`. */
export function button(root: Element, text: string): HTMLButtonElement {
  const found = [...root.querySelectorAll("button")].find((b) => b.textContent === text);
  if (!found) throw new Error(`no "${text}" button`);
  return found;
}
