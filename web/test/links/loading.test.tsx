import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LinksSection } from "../../src/links/LinksSection";
import {
  count,
  gate,
  installApi,
  installClipboard,
  installLegacy,
  isOpen,
  link,
  mountLinks,
  panel,
  row,
  settle,
  standardApi,
  type Bridges,
} from "./harness";

// How the Links island loads (dashboard-react T3a, S2/S5, L9). Ported from the
// Worker tests that compiled the legacy loadLinks out of the served HTML:
// "loadLinks ordering against the auth bootstrap", "loadLinks refresh after an
// edit" and the bootstrap's guarded load. Since T4 (L13) the load is the
// links alone; the Overview cards load themselves and only hear, through
// web/src/overview/changes.ts, that the table reloaded.

const el = (id: string) => document.getElementById(id) as HTMLElement;

describe("Links island — loading", () => {
  let bridges: Bridges;

  beforeEach(() => {
    bridges = installLegacy();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("waits for the auth gate and uses the window.__api bound when it opens", async () => {
    const auth = gate();
    window.__apiReady = auth.wait;
    // The state the page is in while getSession() is still in flight.
    (window as { __api?: unknown }).__api = undefined;

    render(<LinksSection limit={100} />);
    await settle();

    // Parked, not failed: no rendered "window.__api is not a function".
    expect(el("links-empty").style.display).toBe("none");
    expect(el("links-loading").style.display).toBe("");

    const calls = standardApi({ links: [] });
    auth.release();
    await settle();

    expect(calls.length).toBeGreaterThan(0);
    expect(el("links-loading").style.display).toBe("none");
    expect(el("link-count").textContent).toBe("0");
  });

  it("sends no request at all until the auth gate opens", async () => {
    const auth = gate();
    window.__apiReady = auth.wait;
    const calls = standardApi({ links: [] });

    render(<LinksSection limit={100} />);
    await settle();
    expect(calls).toEqual([]);

    auth.release();
    await settle();
    expect(count(calls, "GET", "/api/links")).toBe(1);
  });

  it("paints only the newest load when an older one answers last", async () => {
    const slow = gate();
    let call = 0;
    standardApi({
      links: () => {
        call++;
        if (call === 1) return slow.wait.then(() => [link({ short_code: "stale" })]);
        return [link({ short_code: "fresh" })];
      },
    });

    render(<LinksSection limit={100} />);
    await settle();
    await act(async () => {
      await window.__loadLinks!();
    });
    slow.release();
    await settle();

    expect(row().querySelector(".code")!.textContent).toContain("fresh");
  });

  it("fetches only the links, once on mount: the Overview cards load themselves (L13)", async () => {
    const calls = standardApi();
    await mountLinks();

    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /api/links"]);
  });

  it("shows the loading state on the first load, then the table", async () => {
    const hold = gate();
    standardApi({ links: () => hold.wait.then(() => [link()]) });
    render(<LinksSection limit={100} />);
    await settle();

    expect(el("links-loading").style.display).toBe("");
    expect(el("links-table").style.display).toBe("none");
    expect(el("links-empty").style.display).toBe("none");

    hold.release();
    await settle();

    expect(el("links-loading").style.display).toBe("none");
    expect(el("links-table").style.display).toBe("");
    expect(isOpen()).toBe(false);
  });

  it("counts the links against the plan limit", async () => {
    standardApi({ links: [link({ id: "a" }), link({ id: "b" })] });
    await mountLinks(25);

    expect(document.querySelector("#links-card h3")!.textContent).toBe("Your Links (2/25)");
    expect(el("link-count").textContent).toBe("2");
  });

  it("exposes window.__loadLinks for the legacy callers, and refreshes through it", async () => {
    const calls = standardApi();
    await mountLinks();

    await act(async () => {
      await window.__loadLinks!();
    });
    await settle();

    expect(count(calls, "GET", "/api/links")).toBe(2);
  });

  it("removes window.__loadLinks when the island goes away", async () => {
    standardApi();
    const view = await mountLinks();
    view.unmount();
    expect(window.__loadLinks).toBeUndefined();
  });

  it("keeps the table on screen during a refresh and reopens, refetching, the panels that were open", async () => {
    let hold: Promise<void> | null = null;
    const calls = standardApi({
      links: () => (hold ? hold.then(() => [link({ id: "abc" }), link({ id: "def" })]) : [link({ id: "abc" }), link({ id: "def" })]),
    });
    await mountLinks();

    fireEvent.click(row("abc").querySelector(".clicks-link")!);
    await settle();
    expect(count(calls, "GET", "/api/links/abc/clicks")).toBe(1);

    const refresh = gate();
    hold = refresh.wait;
    act(() => {
      void window.__loadLinks!();
    });
    await settle();

    // Collapsing the table mid-refresh threw the owner back up the page after every Save.
    expect(el("links-table").style.display).toBe("");
    expect(el("links-loading").style.display).toBe("none");

    refresh.release();
    await settle();

    expect(el("links-table").style.display).toBe("");
    expect(isOpen("abc")).toBe(true);
    expect(isOpen("def")).toBe(false);
    // The re-render dropped the figures with the old row, so they are fetched again.
    expect(count(calls, "GET", "/api/links/abc/clicks")).toBe(2);
    expect(count(calls, "GET", "/api/links/def/clicks")).toBe(0);
  });

  it("says when there are no links yet", async () => {
    standardApi({ links: [] });
    await mountLinks();

    expect(el("links-table").style.display).toBe("none");
    expect(el("links-empty").style.display).toBe("");
    expect(el("links-empty").textContent).toBe("No links yet. Create your first one above!");
  });

  it("fails the whole load when the links cannot be read", async () => {
    installApi((_m, path) => {
      if (path === "/api/links") throw new Error("Server error");
      return [];
    });
    await mountLinks();

    expect(el("links-table").style.display).toBe("none");
    expect(el("links-empty").style.display).toBe("");
    expect(el("links-empty").textContent).toBe("Could not load links. Server error");
    expect(el("links-loading").style.display).toBe("none");
  });

  it("renders the table even when the client rollup is down: it no longer shares the load", async () => {
    const calls = installApi((_m, path) => {
      if (path === "/api/clients/metrics" || path === "/api/review-gate/metrics") throw new Error("overview down");
      if (path === "/api/links") return [link()];
      throw new Error(`unexpected ${path}`);
    });
    await mountLinks();

    expect(el("links-table").style.display).toBe("");
    expect(el("links-empty").style.display).toBe("none");
    expect(el("link-count").textContent).toBe("1");
    expect(count(calls, "GET", "/api/clients/metrics")).toBe(0);
    expect(count(calls, "GET", "/api/review-gate/metrics")).toBe(0);
  });

  it("treats a /api/links answer that is not an array as an error, not as no links", async () => {
    standardApi({ links: () => ({ links: [] }) });
    await mountLinks();

    expect(el("links-empty").textContent).toBe("Could not load links. Unexpected /api/links response shape");
  });

  it("tells the Overview after every refresh, so its gate and rollup cards follow the table", async () => {
    standardApi();
    await mountLinks();
    // The first load says nothing: the Overview loads its own cards at boot,
    // and a signal here would fetch them twice.
    expect(bridges.overview).toEqual([]);

    await act(async () => {
      await window.__loadLinks!();
    });
    await settle();
    expect(bridges.overview).toEqual(["links"]);
  });

  it("tells the Overview after a create reloads the table", async () => {
    installClipboard();
    standardApi();
    await mountLinks();

    fireEvent.change(document.getElementById("url") as HTMLInputElement, { target: { value: "https://example.com/x" } });
    await act(async () => {
      fireEvent.submit(document.getElementById("create-form")!);
    });
    await settle();

    expect(bridges.overview).toEqual(["links"]);
  });

  it("says nothing to the Overview when a refresh fails", async () => {
    let fail = false;
    standardApi({
      links: () => {
        if (fail) throw new Error("Server error");
        return [link()];
      },
    });
    await mountLinks();

    fail = true;
    await act(async () => {
      await window.__loadLinks!();
    });
    await settle();
    expect(bridges.overview).toEqual([]);
  });

  it("starts with every panel closed", async () => {
    standardApi();
    await mountLinks();
    expect(panel().style.display).toBe("none");
  });
});
