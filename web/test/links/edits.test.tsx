import { act, cleanup, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reloadLinks } from "../../src/links/reload";
import { clearPrintQueue, getPrintQueue } from "../../src/print-queue";
import {
  button,
  CLICKS,
  count,
  field,
  gate,
  installLegacy,
  isOpen,
  link,
  mountLinks,
  panel,
  provideBranches,
  row,
  settle,
  standardApi,
  type Bridges,
} from "./harness";

// What the row and its panel do. Ported from the Worker tests that compiled
// the legacy save functions out of the served HTML (test/handlers/
// dashboard.test.ts: "field saves repaint only their own link", "repaintLink",
// "setGated updates its field in place", "each row has an Edit button", the
// QR encoding guard, the copy feedback, the metric renderers and
// "renderVisitors", and the print queue in the table). The QR button and its
// modal are pinned in qr.test.tsx (T3b).

let bridges: Bridges;
let alerts: string[];

beforeEach(() => {
  bridges = installLegacy();
  alerts = [];
  vi.stubGlobal("alert", (m: string) => alerts.push(m));
  vi.stubGlobal("confirm", vi.fn(() => true));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const save = (fieldId: string) => fireEvent.click(button(field(fieldId).closest(".field")!, "Save"));
const type = (fieldId: string, value: string) => fireEvent.change(field(fieldId), { target: { value } });
const openPanel = async (id = "link-uuid") => {
  fireEvent.click(row(id).querySelector(".clicks-link")!);
  await settle();
};

describe("destination", () => {
  it("PATCHes the trimmed value and repaints with the normalized URL the server stored, with no reload", async () => {
    const calls = standardApi({ patch: () => ({ ok: true, original_url: "https://example.com/menu" }) });
    await mountLinks();

    type("dest-link-uuid", " example.com/menu ");
    save("dest-link-uuid");
    await settle();

    expect(calls.filter((c) => c.method === "PATCH")).toEqual([
      { method: "PATCH", path: "/api/links/link-uuid", body: { original_url: "example.com/menu" } },
    ]);
    expect(field("dest-link-uuid").value).toBe("https://example.com/menu");
    expect(row().querySelector(".url-trunc")!.textContent).toBe("https://example.com/menu");
    expect(count(calls, "GET", "/api/links")).toBe(1);
  });

  it("sends an emptied field as null, turning the link back into card stock", async () => {
    const calls = standardApi({ patch: () => ({ ok: true, original_url: null }) });
    await mountLinks();

    type("dest-link-uuid", "   ");
    save("dest-link-uuid");
    await settle();

    expect(calls.find((c) => c.method === "PATCH")!.body).toEqual({ original_url: null });
    expect(button(row(), "Send to print")).toBeDefined();
  });

  it("does not validate the URL in the browser: the server owns the rules", async () => {
    const calls = standardApi({ patch: () => ({ ok: true, original_url: "not a url" }) });
    await mountLinks();

    type("dest-link-uuid", "not a url");
    save("dest-link-uuid");
    await settle();

    expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(1);
    expect(alerts).toEqual([]);
  });

  it("on a refusal repaints nothing and keeps what was typed", async () => {
    const calls = standardApi({
      patch: () => {
        throw new Error("Invalid URL");
      },
    });
    await mountLinks();

    type("dest-link-uuid", "not a url");
    save("dest-link-uuid");
    await settle();

    expect(alerts).toEqual(["Error: Invalid URL"]);
    expect(field("dest-link-uuid").value).toBe("not a url");
    expect(row().querySelector(".url-trunc")!.textContent).toBe("https://example.com");
    expect(count(calls, "GET", "/api/links")).toBe(1);
  });

  it("takes a queued card out of the print queue once it has a destination", async () => {
    standardApi({
      links: [link({ original_url: null })],
      patch: () => ({ ok: true, original_url: "https://example.com" }),
    });
    await mountLinks();
    fireEvent.click(button(row(), "Send to print"));
    expect(getPrintQueue()).toHaveLength(1);

    type("dest-link-uuid", "https://example.com");
    save("dest-link-uuid");
    await settle();

    expect(getPrintQueue()).toEqual([]);
  });
});

describe("branch", () => {
  const branches = [
    { id: "loc-1", name: "Centro", business_id: "biz-1", business_name: "Cafe Uno", is_active: true },
    { id: "loc-old", name: "Vieja", business_id: "biz-1", business_name: "Cafe Uno", is_active: true },
  ];

  beforeEach(async () => {
    await provideBranches(branches, [{ id: "biz-1", name: "Cafe Uno", is_active: true }]);
  });

  it("PATCHes the branch and repaints the owner column with the names from the branches list", async () => {
    const calls = standardApi({ links: [link({ location_id: "loc-old", location_name: "Vieja", business_name: "Cafe Uno" })] });
    await mountLinks();

    type("branch-link-uuid", "loc-1");
    save("branch-link-uuid");
    await settle();

    expect(calls.filter((c) => c.method === "PATCH")).toEqual([
      { method: "PATCH", path: "/api/links/link-uuid", body: { location_id: "loc-1" } },
    ]);
    expect(row().querySelector(".owner-branch")!.textContent).toBe("Centro");
    expect(row().querySelector(".owner-business")!.textContent).toBe("Cafe Uno");
    expect(field("branch-link-uuid").value).toBe("loc-1");
    expect(field("branch-link-uuid").dataset.current).toBe("loc-1");
    expect(count(calls, "GET", "/api/links")).toBe(1);
  });

  it("unassigns with null and clears the names", async () => {
    const calls = standardApi({ links: [link({ location_id: "loc-old", location_name: "Vieja", business_name: "Cafe Uno" })] });
    await mountLinks();

    type("branch-link-uuid", "");
    save("branch-link-uuid");
    await settle();

    expect(calls.find((c) => c.method === "PATCH")!.body).toEqual({ location_id: null });
    expect(row().querySelector(".owner-none")!.textContent).toBe("Unassigned");
  });

  it("puts the picker back on the stored branch when the server refuses", async () => {
    standardApi({
      links: [link({ location_id: "loc-old", location_name: "Vieja" })],
      patch: () => {
        throw new Error("Failed");
      },
    });
    await mountLinks();

    type("branch-link-uuid", "loc-1");
    save("branch-link-uuid");
    await settle();

    expect(field("branch-link-uuid").value).toBe("loc-old");
    expect(row().querySelector(".owner-branch")!.textContent).toBe("Vieja");
    expect(alerts).toHaveLength(1);
  });

  it("drops an unsaved pick when that branch stops being pickable, so Save never sends it", async () => {
    const calls = standardApi({ links: [link({ location_id: "loc-old", location_name: "Vieja" })] });
    await mountLinks();

    type("branch-link-uuid", "loc-1");
    await provideBranches([{ ...branches[0]!, is_active: false }, branches[1]!], [{ id: "biz-1", name: "Cafe Uno", is_active: true }]);
    expect(field("branch-link-uuid").value).toBe("loc-old");

    save("branch-link-uuid");
    await settle();
    expect(calls.find((c) => c.method === "PATCH")!.body).toEqual({ location_id: "loc-old" });
  });
});

describe("client ref", () => {
  it("PATCHes the trimmed value, repaints the row and tells the Overview to refresh only the rollup", async () => {
    const calls = standardApi();
    await mountLinks();

    type("client-ref-link-uuid", " CRM-7 ");
    save("client-ref-link-uuid");
    await settle();

    expect(calls.filter((c) => c.method === "PATCH")).toEqual([
      { method: "PATCH", path: "/api/links/link-uuid", body: { client_ref: "CRM-7" } },
    ]);
    expect(field("client-ref-link-uuid").value).toBe("CRM-7");
    expect(bridges.overview).toEqual(["client-ref"]);
    expect(count(calls, "GET", "/api/links")).toBe(1);
  });

  it("stores an emptied field as null", async () => {
    const calls = standardApi({ links: [link({ client_ref: "old" })] });
    await mountLinks();

    type("client-ref-link-uuid", "  ");
    save("client-ref-link-uuid");
    await settle();

    expect(calls.find((c) => c.method === "PATCH")!.body).toEqual({ client_ref: null });
    expect(field("client-ref-link-uuid").value).toBe("");
  });

  it("alerts on a refusal and leaves the rollup alone", async () => {
    standardApi({
      patch: () => {
        throw new Error("nope");
      },
    });
    await mountLinks();

    type("client-ref-link-uuid", "x");
    save("client-ref-link-uuid");
    await settle();

    expect(alerts).toEqual(["Error: nope"]);
    expect(bridges.overview).toEqual([]);
  });
});

describe("disable / enable", () => {
  it("PATCHes the new state and repaints the row with it", async () => {
    const calls = standardApi();
    await mountLinks();

    fireEvent.click(button(panel(), "Disable"));
    await settle();

    expect(calls.filter((c) => c.method === "PATCH")).toEqual([
      { method: "PATCH", path: "/api/links/link-uuid", body: { is_active: false } },
    ]);
    expect(row().querySelector(".badge-inactive")).not.toBeNull();
    expect(button(panel(), "Enable")).toBeDefined();
    expect(count(calls, "GET", "/api/links")).toBe(1);
  });

  it("alerts and repaints nothing when the change is refused", async () => {
    standardApi({
      patch: () => {
        throw new Error("Failed");
      },
    });
    await mountLinks();

    fireEvent.click(button(panel(), "Disable"));
    await settle();

    expect(alerts).toEqual(["Error: Failed"]);
    expect(row().querySelector(".badge-active")).not.toBeNull();
  });
});

describe("review screen checkbox", () => {
  const box = () => panel().querySelector('input[type="checkbox"]') as HTMLInputElement;
  const notes = () => [...panel().querySelectorAll<HTMLElement>("[data-gate-note]")].map((n) => n.hidden);

  it("flips the box and its note at once, with one request and no table reload", async () => {
    const hold = gate();
    const calls = standardApi({ links: [link({ is_gated: false })], patch: () => hold.wait.then(() => ({ ok: true })) });
    await mountLinks();

    fireEvent.click(box());
    await settle();

    // Optimistic: the click is the answer, the request only confirms it.
    expect(box().checked).toBe(true);
    expect(box().disabled).toBe(true);
    expect(notes()).toEqual([false, true]);

    hold.release();
    await settle();

    expect(calls.filter((c) => c.method === "PATCH")).toEqual([
      { method: "PATCH", path: "/api/links/link-uuid", body: { is_gated: true } },
    ]);
    expect(box().checked).toBe(true);
    expect(box().disabled).toBe(false);
    expect(count(calls, "GET", "/api/links")).toBe(1);
    expect(alerts).toEqual([]);
  });

  it("puts the box and the note back when the server refuses", async () => {
    standardApi({
      links: [link({ is_gated: false })],
      patch: () => {
        throw new Error("Failed");
      },
    });
    await mountLinks();

    fireEvent.click(box());
    await settle();

    expect(box().checked).toBe(false);
    expect(box().disabled).toBe(false);
    expect(notes()).toEqual([true, false]);
    expect(alerts).toHaveLength(1);
  });
});

describe("repaint of one link", () => {
  it("keeps the panel open, its fetched figures and unsaved typing in the other fields", async () => {
    const calls = standardApi({ patch: () => ({ ok: true, original_url: "https://example.com/new" }) });
    await mountLinks();
    await openPanel();
    expect(document.getElementById("country-link-uuid")!.textContent).toContain("AR");

    type("client-ref-link-uuid", "typed, not saved");
    type("dest-link-uuid", "example.com/new");
    save("dest-link-uuid");
    await settle();

    expect(isOpen()).toBe(true);
    expect(document.getElementById("country-link-uuid")!.textContent).toContain("AR");
    expect(count(calls, "GET", "/api/links/link-uuid/clicks")).toBe(1);
    expect(field("client-ref-link-uuid").value).toBe("typed, not saved");
    expect(field("dest-link-uuid").value).toBe("https://example.com/new");
  });

  it("leaves the other links' rows alone", async () => {
    standardApi({ links: [link({ id: "a" }), link({ id: "b" })] });
    await mountLinks();
    type("client-ref-b", "draft on b");

    fireEvent.click(button(panel("a"), "Disable"));
    await settle();

    expect(row("a").querySelector(".badge-inactive")).not.toBeNull();
    expect(row("b").querySelector(".badge-active")).not.toBeNull();
    expect(field("client-ref-b").value).toBe("draft on b");
  });
});

describe("delete", () => {
  it("asks first and does nothing on cancel", async () => {
    vi.stubGlobal("confirm", vi.fn(() => false));
    const calls = standardApi();
    await mountLinks();

    fireEvent.click(button(row(), "Del"));
    await settle();

    expect(window.confirm).toHaveBeenCalledWith("Delete this link permanently?");
    expect(calls.filter((c) => c.method === "DELETE")).toEqual([]);
  });

  it("DELETEs the link, then reloads the table", async () => {
    let links = [link({ id: "a" }), link({ id: "b" })];
    const calls = standardApi({
      links: () => links,
      del: (id) => {
        links = links.filter((l) => l.id !== id);
        return { ok: true };
      },
    });
    await mountLinks();

    fireEvent.click(button(row("a"), "Del"));
    await settle();

    expect(calls.filter((c) => c.method === "DELETE")).toEqual([{ method: "DELETE", path: "/api/links/a" }]);
    expect(count(calls, "GET", "/api/links")).toBe(2);
    expect(document.getElementById("metrics-a")).toBeNull();
    expect(document.getElementById("link-count")!.textContent).toBe("1");
  });

  it("alerts when the delete is refused", async () => {
    standardApi({
      del: () => {
        throw new Error("Failed");
      },
    });
    await mountLinks();

    fireEvent.click(button(row(), "Del"));
    await settle();

    expect(alerts).toEqual(["Error: Failed"]);
  });
});

describe("copy", () => {
  it("copies the short URL and says Copied! for 1.5 s on the code itself", async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    standardApi();
    await mountLinks();
    vi.useFakeTimers();

    const code = row().querySelector(".code")!;
    await act(async () => {
      fireEvent.click(code);
    });

    expect(writeText).toHaveBeenCalledWith("https://short.link/abc1234");
    expect(code.textContent).toBe("Copied!");
    act(() => {
      vi.advanceTimersByTime(1499);
    });
    expect(code.textContent).toBe("Copied!");
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(code.textContent).toBe("abc1234");
  });

  it("falls back to a selected input and execCommand when the clipboard is refused", async () => {
    vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn(async () => Promise.reject(new Error("denied"))) } });
    const exec = vi.fn(() => true);
    document.execCommand = exec;
    standardApi();
    await mountLinks();

    const code = row().querySelector(".code")!;
    await act(async () => {
      fireEvent.click(code);
    });
    await settle();

    expect(exec).toHaveBeenCalledWith("copy");
    expect(code.textContent).toBe("Copied!");
    expect(document.querySelectorAll("body > input")).toHaveLength(0);
  });
});

describe("metrics panel", () => {
  it("opens on the clicks count, fetches the figures once and keeps them across reopening", async () => {
    const calls = standardApi();
    await mountLinks();

    await openPanel();
    expect(isOpen()).toBe(true);
    fireEvent.click(row().querySelector(".clicks-link")!);
    expect(isOpen()).toBe(false);
    await openPanel();

    expect(isOpen()).toBe(true);
    expect(count(calls, "GET", "/api/links/link-uuid/clicks")).toBe(1);
  });

  it("shows both visitor figures with equal markup, labelled with the windows the API used", async () => {
    standardApi({ clicks: () => ({ ...CLICKS, unique_window: "7 days", session_window: "15 minutes" }) });
    await mountLinks();
    await openPanel();

    const rows = [...document.getElementById("visitors-link-uuid")!.children];
    expect(rows.map((r) => r.outerHTML)).toEqual([
      '<div class="metric-row"><span>Unique visitors (last 7 days)</span><strong>30</strong></div>',
      '<div class="metric-row"><span>Sessions (per 15 minutes)</span><strong>42</strong></div>',
    ]);
  });

  it("reports zero rather than undefined, and the default windows, when the API leaves them out", async () => {
    standardApi({ clicks: () => ({ by_country: {}, by_device: {} }) });
    await mountLinks();
    await openPanel();

    const visitors = document.getElementById("visitors-link-uuid")!;
    expect(visitors.textContent).toBe("Unique visitors (last 1 day)0Sessions (per 30 minutes)0");
  });

  it("lists each breakdown busiest first, and says No data when empty", async () => {
    standardApi();
    await mountLinks();
    await openPanel();

    const country = [...document.getElementById("country-link-uuid")!.querySelectorAll(".metric-row")];
    expect(country.map((r) => r.textContent)).toEqual(["AR7", "CL3"]);
    expect(document.getElementById("device-link-uuid")!.textContent).toBe("mobile9");
    expect(document.getElementById("source-link-uuid")!.innerHTML).toBe('<div class="metric-row">No data</div>');
  });

  it("puts breakdown keys from request data in as text", async () => {
    standardApi({ clicks: () => ({ ...CLICKS, by_source: { "<img src=x onerror=alert(1)>": 2 } }) });
    await mountLinks();
    await openPanel();

    const source = document.getElementById("source-link-uuid")!;
    expect(source.querySelector("img")).toBeNull();
    expect(source.textContent).toBe("<img src=x onerror=alert(1)>2");
  });

  it("shows the error as text in the country box, and tries again on the next opening", async () => {
    let fail = true;
    const calls = standardApi({
      clicks: () => {
        if (fail) throw new Error("<b>boom</b>");
        return CLICKS;
      },
    });
    await mountLinks();
    await openPanel();

    const country = document.getElementById("country-link-uuid")!;
    expect(country.textContent).toBe("Error: <b>boom</b>");
    expect(country.querySelector("b")).toBeNull();

    fail = false;
    fireEvent.click(row().querySelector(".clicks-link")!);
    await openPanel();
    expect(count(calls, "GET", "/api/links/link-uuid/clicks")).toBe(2);
    expect(document.getElementById("country-link-uuid")!.textContent).toContain("AR");
  });
});

describe("Edit button", () => {
  it("opens a closed panel and puts the cursor in the destination", async () => {
    const calls = standardApi();
    await mountLinks();

    fireEvent.click(button(row(), "Edit"));
    await settle();

    expect(isOpen()).toBe(true);
    expect(document.activeElement).toBe(field("dest-link-uuid"));
    expect(count(calls, "GET", "/api/links/link-uuid/clicks")).toBe(1);
  });

  it("never closes an open panel, and still focuses the destination", async () => {
    const calls = standardApi();
    await mountLinks();
    await openPanel();
    field("client-ref-link-uuid").focus();

    fireEvent.click(button(row(), "Edit"));
    await settle();

    expect(isOpen()).toBe(true);
    expect(document.activeElement).toBe(field("dest-link-uuid"));
    expect(count(calls, "GET", "/api/links/link-uuid/clicks")).toBe(1);
  });
});

describe("print queue in the table", () => {
  it("queues an unconfigured link on the click, with no request and no reload", async () => {
    const calls = standardApi({ links: [link({ original_url: null })] });
    await mountLinks();
    const before = calls.length;

    fireEvent.click(button(row(), "Send to print"));

    expect(getPrintQueue()).toEqual([{ id: "link-uuid", short_code: "abc1234" }]);
    expect(calls.length).toBe(before);
    expect((row().querySelector("[data-print-badge]") as HTMLElement).hidden).toBe(false);
    // Both copies follow: the row and the panel.
    expect([...document.querySelectorAll("#links-body button")].filter((b) => b.textContent === "Remove from queue")).toHaveLength(2);
  });

  it("takes it out again from either copy of the control", async () => {
    standardApi({ links: [link({ original_url: null })] });
    await mountLinks();
    fireEvent.click(button(row(), "Send to print"));

    fireEvent.click(button(panel(), "Remove from queue"));

    expect(getPrintQueue()).toEqual([]);
    expect((row().querySelector("[data-print-badge]") as HTMLElement).hidden).toBe(true);
    expect(button(row(), "Send to print")).toBeDefined();
  });

  it("resets every row when the Cards island marks the batch printed, leaving open panels open", async () => {
    standardApi({ links: [link({ id: "a", original_url: null }), link({ id: "b", original_url: null })] });
    await mountLinks();
    fireEvent.click(button(row("a"), "Send to print"));
    fireEvent.click(button(row("b"), "Send to print"));
    await openPanel("a");

    act(() => {
      window.__clearPrintQueue();
    });

    expect(button(row("a"), "Send to print")).toBeDefined();
    expect(button(row("b"), "Send to print")).toBeDefined();
    expect(isOpen("a")).toBe(true);
  });

  it("drops deleted and configured links from the queue on every load", async () => {
    let links = [link({ id: "a", original_url: null }), link({ id: "b", original_url: null })];
    standardApi({ links: () => links });
    await mountLinks();
    fireEvent.click(button(row("a"), "Send to print"));
    fireEvent.click(button(row("b"), "Send to print"));

    links = [link({ id: "a", original_url: "https://configured.example" })];
    await act(async () => {
      await reloadLinks();
    });
    await settle();

    expect(getPrintQueue()).toEqual([]);
    clearPrintQueue();
  });
});
