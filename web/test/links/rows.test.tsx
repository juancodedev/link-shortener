import { cleanup } from "@testing-library/react";
import { VISITOR_ESTIMATE_CAVEAT } from "../../../src/analytics/metrics";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installLegacy, link, mountLinks, panel, row, standardApi } from "./harness";

// What one link renders: its row and its editing panel. Ported from the
// Worker tests that compiled the legacy renderLinkRow out of the served HTML
// (test/handlers/dashboard.test.ts: escaping, inline handlers, Phase 2 guards,
// destination field, owner column, review checkbox, Edit button, print queue
// in the table; and all of test/handlers/links-row-reachability.test.ts).

const XSS_URL = "<img src=x onerror=alert(1)>";
const XSS_CODE = "');alert(1)//";
const XSS_ATTR = '"><img src=x onerror=alert(1)>';

async function show(over: Record<string, unknown> = {}) {
  standardApi({ links: [link(over)] });
  await mountLinks();
  return { row: row(String(over.id ?? "link-uuid")), panel: panel(String(over.id ?? "link-uuid")) };
}

const buttons = (root: Element) => [...root.querySelectorAll("button")].map((b) => b.textContent);
const text = (root: Element) => root.textContent ?? "";

describe("Links island — record data is text, never markup", () => {
  beforeEach(() => {
    installLegacy();
  });
  afterEach(cleanup);

  it("creates no element from a destination that carries markup, in any position", async () => {
    const { row, panel } = await show({ original_url: XSS_ATTR });

    expect(document.querySelector("#links-body img")).toBeNull();
    expect(row.querySelector(".url-trunc")!.textContent).toBe(XSS_ATTR);
    expect(row.querySelector(".url-trunc")!.getAttribute("title")).toBe(XSS_ATTR);
    expect((panel.querySelector("#dest-link-uuid") as HTMLInputElement).value).toBe(XSS_ATTR);
  });

  it("keeps a hostile short code inert", async () => {
    const { row } = await show({ short_code: XSS_CODE });

    expect(row.querySelector(".code")!.textContent).toBe(XSS_CODE);
    expect(document.querySelector("#links-body img")).toBeNull();
  });

  it("puts client_ref, business and branch names in as text", async () => {
    const { row, panel } = await show({ client_ref: XSS_ATTR, business_name: XSS_URL, location_name: XSS_URL });

    expect((panel.querySelector("#client-ref-link-uuid") as HTMLInputElement).value).toBe(XSS_ATTR);
    expect(row.querySelector(".owner-business")!.textContent).toBe(XSS_URL);
    expect(row.querySelector(".owner-branch")!.textContent).toBe(XSS_URL);
    expect(document.querySelector("#links-body img")).toBeNull();
  });

  it("renders null fields as empty rather than 'null'", async () => {
    const { row, panel } = await show({ client_ref: null, title: null });

    expect(text(row)).not.toContain("null");
    expect((panel.querySelector("#client-ref-link-uuid") as HTMLInputElement).value).toBe("");
  });

  it("carries no inline event handler attribute anywhere in the table", async () => {
    await show();

    const inline = [...document.querySelectorAll("#links-table *")].flatMap((node) =>
      [...node.attributes].filter((a) => /^on/i.test(a.name)).map((a) => a.name),
    );
    expect(inline).toEqual([]);
  });
});

describe("Links island — the row", () => {
  beforeEach(() => {
    installLegacy();
  });
  afterEach(cleanup);

  it("emits no text input in the row, only in its panel", async () => {
    const { row } = await show({ client_ref: "Cafe Central" });

    expect(row.querySelector('input[type="text"]')).toBeNull();
  });

  it("emits exactly two short buttons, Edit then the destructive Del", async () => {
    const { row } = await show();

    expect(buttons(row)).toEqual(["Edit", "Del"]);
    expect(row.querySelectorAll(".btn-danger")).toHaveLength(1);
    expect(row.querySelector(".row-actions")!.lastElementChild!.textContent).toBe("Del");
  });

  it("offers copy on the short code and the panel on the clicks count, nothing else", async () => {
    const { row } = await show({ clicks_count: 5 });

    expect(row.querySelector(".code")!.getAttribute("title")).toBe("Click to copy https://short.link/abc1234");
    expect(row.querySelector("a.clicks-link")!.textContent).toBe("5");
    expect(row.querySelectorAll("a")).toHaveLength(1);
  });

  it("labels how the link opens", async () => {
    expect(text((await show({ is_gated: true })).row)).toContain("Review screen");
    cleanup();
    installLegacy();
    const direct = (await show({ is_gated: false })).row;
    expect(direct.querySelector(".badge-direct")!.textContent).toBe("Direct");
    expect(direct.querySelector(".badge-gated")).toBeNull();
  });

  it("shows the business and branch, or Unassigned", async () => {
    const owned = (await show({ business_name: "Café Central", location_name: "Providencia" })).row;
    expect(owned.querySelector(".owner-business")!.textContent).toBe("Café Central");
    expect(owned.querySelector(".owner-branch")!.textContent).toBe("Providencia");
    cleanup();
    installLegacy();
    const none = (await show({ location_name: null })).row;
    expect(none.querySelector(".owner-none")!.textContent).toBe("Unassigned");
  });

  it("names a branch with no business 'No business'", async () => {
    const { row } = await show({ business_name: null, location_name: "Suelta" });
    expect(row.querySelector(".owner-business")!.textContent).toBe("No business");
  });

  it("marks the status: active, inactive, or expired", async () => {
    expect((await show()).row.querySelector(".badge-active")!.textContent).toBe("active");
    cleanup();
    installLegacy();
    expect((await show({ is_active: false })).row.querySelector(".badge-inactive")!.textContent).toBe("inactive");
    cleanup();
    installLegacy();
    expect((await show({ expires_at: "2000-01-01T00:00:00Z" })).row.querySelector(".badge-expired")!.textContent).toBe("expired");
  });

  it("hides the business/branch, URL and Opens cells on narrow screens, never the actions", async () => {
    const { row } = await show();

    const hidden = [...row.querySelectorAll("td.hide-sm")];
    expect(hidden).toHaveLength(3);
    expect(hidden.some((td) => td.querySelector(".row-actions"))).toBe(false);
  });

  it("offers Send to print on an unconfigured link, outside the two-button actions cell", async () => {
    const { row } = await show({ original_url: null });

    const send = [...row.querySelectorAll("button")].find((b) => b.textContent === "Send to print");
    expect(send).toBeDefined();
    expect(send!.closest(".row-actions")).toBeNull();
    const badge = row.querySelector('[data-print-badge="link-uuid"]') as HTMLElement;
    expect(badge.textContent).toBe("To print");
    expect(badge.hidden).toBe(true);
  });

  it("offers no print control on a configured link", async () => {
    const { row, panel } = await show({ original_url: "https://g.page/r/x" });

    expect(text(row) + text(panel)).not.toContain("Send to print");
    expect(row.querySelector("[data-print-badge]")).toBeNull();
  });
});

describe("Links island — the editing panel", () => {
  beforeEach(() => {
    installLegacy();
  });
  afterEach(cleanup);

  it("starts closed, as its own table row spanning every column", async () => {
    const { panel } = await show();

    expect(panel.style.display).toBe("none");
    expect(panel.querySelector("td")!.getAttribute("colspan")).toBe("7");
  });

  it("carries the client ref field and its Save", async () => {
    const { panel } = await show({ client_ref: "Cafe Central" });

    const input = panel.querySelector("#client-ref-link-uuid") as HTMLInputElement;
    expect(input.value).toBe("Cafe Central");
    expect(input.placeholder).toBe("None");
    expect(input.maxLength).toBe(200);
    expect(button(input.closest(".field")!, "Save")).toBeDefined();
  });

  it("keeps the QR print-sheet entry point in the panel, not the row", async () => {
    const { row, panel } = await show();

    expect(buttons(row)).not.toContain("QR code");
    expect(buttons(panel)).toContain("QR code");
  });

  it("repeats the print control in the panel, which every screen size reaches", async () => {
    const { panel } = await show({ original_url: null });
    expect(buttons(panel)).toContain("Send to print");
  });

  it("shows the current destination in an editable field on every link", async () => {
    const { panel } = await show({ original_url: "https://g.page/r/abc/review" });

    expect((panel.querySelector("#dest-link-uuid") as HTMLInputElement).value).toBe("https://g.page/r/abc/review");
    expect(text(panel)).toContain("Changing it does not need a reprint.");
    expect(text(panel)).not.toContain("not configured");
  });

  it("offers the same field on card stock, empty, and says what a scan shows", async () => {
    const { panel } = await show({ original_url: null });

    const input = panel.querySelector("#dest-link-uuid") as HTMLInputElement;
    expect(input.value).toBe("");
    expect(input.placeholder).toBe("Not configured yet");
    expect(text(panel)).toContain("not configured");
    expect(text(panel)).toContain("does not need reprinting");
  });

  it("offers a branch picker that remembers the link's branch", async () => {
    const { panel } = await show({ location_id: "loc-1" });

    expect((panel.querySelector("#branch-link-uuid") as HTMLSelectElement).dataset.current).toBe("loc-1");
  });

  it("shows the review screen checkbox in the link's state, with the matching note only", async () => {
    const on = (await show({ is_gated: true })).panel;
    const box = on.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(box.checked).toBe(true);
    expect((on.querySelector('[data-gate-note="on"]') as HTMLElement).hidden).toBe(false);
    expect((on.querySelector('[data-gate-note="off"]') as HTMLElement).hidden).toBe(true);
    cleanup();
    installLegacy();
    const off = (await show({ is_gated: false })).panel;
    expect((off.querySelector('input[type="checkbox"]') as HTMLInputElement).checked).toBe(false);
    expect((off.querySelector('[data-gate-note="on"]') as HTMLElement).hidden).toBe(true);
    expect((off.querySelector('[data-gate-note="off"]') as HTMLElement).hidden).toBe(false);
  });

  it("states what disabling a tag does, and the other thing when enabling", async () => {
    const active = (await show({ is_active: true })).panel;
    expect(buttons(active)).toContain("Disable");
    expect(text(active)).toContain("sticker");
    expect(text(active)).toContain("cache");
    cleanup();
    installLegacy();
    const inactive = (await show({ is_active: false })).panel;
    expect(buttons(inactive)).toContain("Enable");
    expect(text(inactive)).not.toContain("stops working");
  });

  it("keeps the visitor estimate and the three breakdowns, each with its own box", async () => {
    const { panel } = await show({ id: "abc" });

    for (const id of ["visitors-abc", "country-abc", "device-abc", "source-abc"]) {
      expect(panel.querySelector(`#${id}`)).not.toBeNull();
    }
    expect([...panel.querySelectorAll(".metrics-grid h4")].map((h) => h.textContent)).toEqual([
      "By Country",
      "By Device",
      "By Source",
    ]);
  });

  it("labels the visitors box an estimate and repeats the caveat right beside the figures", async () => {
    const { panel } = await show({ id: "abc" });

    const box = panel.querySelector(".visitors-box")!;
    expect(box.querySelector("h4")!.textContent).toBe("Visitors (estimate)");
    expect(box.querySelector("#visitors-abc")).not.toBeNull();
    expect(box.querySelector(".estimate-note")!.textContent).toBe(VISITOR_ESTIMATE_CAVEAT);
  });
});

describe("Links island — the table around the rows", () => {
  beforeEach(() => {
    installLegacy();
  });
  afterEach(cleanup);

  it("keeps the reading headers in order, with no Client Ref column", async () => {
    await show();

    const head = [...document.querySelectorAll("#links-table thead th")].map((th) => th.textContent);
    expect(head).toEqual(["Short Code", "Business / branch", "URL", "Opens", "Clicks", "Status", ""]);
    expect(document.querySelectorAll("#links-table thead th.hide-sm")).toHaveLength(3);
  });

  it("states the visitor caveat under the table, before any panel is opened", async () => {
    await show();

    const note = [...document.querySelectorAll(".estimate-note")].find((p) => p.querySelector("strong"));
    expect(note!.textContent).toBe(`About visitor figures: ${VISITOR_ESTIMATE_CAVEAT}`);
  });
});

function button(root: Element, label: string) {
  const found = [...root.querySelectorAll("button")].find((b) => b.textContent === label);
  if (!found) throw new Error(`no ${label} button`);
  return found;
}
