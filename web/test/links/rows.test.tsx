import { act, cleanup } from "@testing-library/react";
import { VISITOR_ESTIMATE_CAVEAT } from "../../../src/analytics/metrics";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getPrintQueue, setPrintQueued } from "../../src/print-queue";
import { installLegacy, link, mountLinks, panel, row, settle, standardApi } from "./harness";

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

    expect(buttons(row)).toEqual(["Editar", "Eliminar"]);
    expect(row.querySelectorAll(".btn-danger")).toHaveLength(1);
    expect(row.querySelector(".row-actions")!.lastElementChild!.textContent).toBe("Eliminar");
  });

  it("offers copy on the short code and the panel on the clicks count, nothing else", async () => {
    const { row } = await show({ clicks_count: 5 });

    expect(row.querySelector(".code")!.getAttribute("title")).toBe("Haz clic para copiar https://short.link/abc1234");
    expect(row.querySelector("a.clicks-link")!.textContent).toBe("5");
    expect(row.querySelectorAll("a")).toHaveLength(1);
  });

  it("labels how the link opens", async () => {
    expect(text((await show({ is_gated: true })).row)).toContain("Pantalla de reseña");
    cleanup();
    installLegacy();
    const direct = (await show({ is_gated: false })).row;
    expect(direct.querySelector(".badge-direct")!.textContent).toBe("Directo");
    expect(direct.querySelector(".badge-gated")).toBeNull();
  });

  it("shows the business and branch, or Unassigned", async () => {
    const owned = (await show({ business_name: "Café Central", location_name: "Providencia" })).row;
    expect(owned.querySelector(".owner-business")!.textContent).toBe("Café Central");
    expect(owned.querySelector(".owner-branch")!.textContent).toBe("Providencia");
    cleanup();
    installLegacy();
    const none = (await show({ location_name: null })).row;
    expect(none.querySelector(".owner-none")!.textContent).toBe("Sin asignar");
  });

  it("names a branch with no business 'No business'", async () => {
    const { row } = await show({ business_name: null, location_name: "Suelta" });
    expect(row.querySelector(".owner-business")!.textContent).toBe("Sin local");
  });

  it("marks the status: active, inactive, or expired", async () => {
    expect((await show()).row.querySelector(".badge-active")!.textContent).toBe("Activo");
    cleanup();
    installLegacy();
    expect((await show({ is_active: false })).row.querySelector(".badge-inactive")!.textContent).toBe("Inactivo");
    cleanup();
    installLegacy();
    expect((await show({ expires_at: "2000-01-01T00:00:00Z" })).row.querySelector(".badge-expired")!.textContent).toBe("Vencido");
  });

  it("hides the business/branch, URL and Opens cells on narrow screens, never the actions", async () => {
    const { row } = await show();

    const hidden = [...row.querySelectorAll("td.hide-sm")];
    expect(hidden).toHaveLength(3);
    expect(hidden.some((td) => td.querySelector(".row-actions"))).toBe(false);
  });

  it("offers Send to print on an unconfigured link, outside the two-button actions cell", async () => {
    const { row } = await show({ original_url: null });

    const send = [...row.querySelectorAll("button")].find((b) => b.textContent === "Enviar a imprimir");
    expect(send).toBeDefined();
    expect(send!.closest(".row-actions")).toBeNull();
    const badge = row.querySelector('[data-print-badge="link-uuid"]') as HTMLElement;
    expect(badge.textContent).toBe("Por imprimir");
    expect(badge.hidden).toBe(true);
  });

  it("offers no print control on a configured link", async () => {
    const { row, panel } = await show({ original_url: "https://g.page/r/x" });

    expect(text(row) + text(panel)).not.toContain("Enviar a imprimir");
    expect(row.querySelector("[data-print-badge]")).toBeNull();
  });

  it("says Printed on a card that was already printed, with the run in its title", async () => {
    const { row } = await show({ original_url: null, printed_at: "2026-11-19T12:00:00Z" });

    const badge = row.querySelector('[data-print-badge="link-uuid"]') as HTMLElement;
    expect(badge.hidden).toBe(false);
    expect(badge.textContent).toBe("Impresa");
    expect(badge.classList.contains("badge-printed")).toBe(true);
    expect(badge.title).toMatch(/^Impresa el /);
  });

  it("offers Reprint, not Send to print, on a card that was already printed", async () => {
    const { row, panel } = await show({ original_url: null, printed_at: "2026-11-19T12:00:00Z" });

    expect(text(row) + text(panel)).toContain("Reimprimir");
    expect(text(row) + text(panel)).not.toContain("Enviar a imprimir");
  });

  it("still offers Send to print on a card that was never printed", async () => {
    const { row } = await show({ original_url: null, printed_at: null });

    expect(text(row)).toContain("Enviar a imprimir");
    expect(text(row)).not.toContain("Reimprimir");
  });

  it("queues a printed card through Reprint and lets it leave the queue again", async () => {
    await show({ original_url: null, printed_at: "2026-11-19T12:00:00Z" });
    const reprint = [...row("link-uuid").querySelectorAll("button")].find((b) => b.textContent === "Reimprimir")!;

    act(() => reprint.click());
    await settle();
    expect(getPrintQueue().map((q) => q.id)).toEqual(["link-uuid"]);
    expect(text(row("link-uuid"))).toContain("Quitar de la cola");

    const remove = [...row("link-uuid").querySelectorAll("button")].find((b) => b.textContent === "Quitar de la cola")!;
    act(() => remove.click());
    await settle();
    expect(text(row("link-uuid"))).toContain("Reimprimir");
  });

  it("offers no print control on a printed card that has a destination", async () => {
    const { row, panel } = await show({ original_url: "https://g.page/r/x", printed_at: "2026-11-19T12:00:00Z" });

    expect(text(row) + text(panel)).not.toContain("Reimprimir");
    expect(text(row) + text(panel)).not.toContain("Enviar a imprimir");
  });

  it("lets the queue badge win when a printed card is sent to print again", async () => {
    await show({ original_url: null, printed_at: "2026-11-19T12:00:00Z" });

    act(() => setPrintQueued("link-uuid", true, "abc1234"));
    await settle();

    const badge = row("link-uuid").querySelector('[data-print-badge="link-uuid"]') as HTMLElement;
    expect(badge.hidden).toBe(false);
    expect(badge.textContent).toBe("Por imprimir");
    expect(badge.classList.contains("badge-queued")).toBe(true);
  });

  it("brings the Printed badge back when the card leaves the queue again", async () => {
    await show({ original_url: null, printed_at: "2026-11-19T12:00:00Z" });

    act(() => setPrintQueued("link-uuid", true, "abc1234"));
    await settle();
    act(() => setPrintQueued("link-uuid", false));
    await settle();

    const badge = row("link-uuid").querySelector('[data-print-badge="link-uuid"]') as HTMLElement;
    expect(badge.textContent).toBe("Impresa");
    expect(badge.classList.contains("badge-printed")).toBe(true);
    expect(badge.title).toMatch(/^Impresa el /);
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
    expect(input.placeholder).toBe("Ninguna");
    expect(input.maxLength).toBe(200);
    expect(button(input.closest(".field")!, "Guardar")).toBeDefined();
  });

  it("keeps the QR print-sheet entry point in the panel, not the row", async () => {
    const { row, panel } = await show();

    expect(buttons(row)).not.toContain("Código QR");
    expect(buttons(panel)).toContain("Código QR");
  });

  it("repeats the print control in the panel, which every screen size reaches", async () => {
    const { panel } = await show({ original_url: null });
    expect(buttons(panel)).toContain("Enviar a imprimir");
  });

  it("shows the current destination in an editable field on every link", async () => {
    const { panel } = await show({ original_url: "https://g.page/r/abc/review" });

    expect((panel.querySelector("#dest-link-uuid") as HTMLInputElement).value).toBe("https://g.page/r/abc/review");
    expect(text(panel)).toContain("Cambiarlo no requiere reimprimir.");
    expect(text(panel)).not.toContain("sin configurar");
  });

  it("offers the same field on card stock, empty, and says what a scan shows", async () => {
    const { panel } = await show({ original_url: null });

    const input = panel.querySelector("#dest-link-uuid") as HTMLInputElement;
    expect(input.value).toBe("");
    expect(input.placeholder).toBe("Sin configurar");
    expect(text(panel)).toContain("sin configurar");
    expect(text(panel)).toContain("no necesita reimprimirse");
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
    expect(buttons(active)).toContain("Desactivar");
    expect(text(active)).toContain("adhesivo");
    expect(text(active)).toContain("caché");
    cleanup();
    installLegacy();
    const inactive = (await show({ is_active: false })).panel;
    expect(buttons(inactive)).toContain("Activar");
    expect(text(inactive)).not.toContain("deja de funcionar");
  });

  it("keeps the visitor estimate and the three breakdowns, each with its own box", async () => {
    const { panel } = await show({ id: "abc" });

    for (const id of ["visitors-abc", "country-abc", "device-abc", "source-abc"]) {
      expect(panel.querySelector(`#${id}`)).not.toBeNull();
    }
    expect([...panel.querySelectorAll(".metrics-grid h4")].map((h) => h.textContent)).toEqual([
      "Por país",
      "Por dispositivo",
      "Por origen",
    ]);
  });

  it("labels the visitors box an estimate and repeats the caveat right beside the figures", async () => {
    const { panel } = await show({ id: "abc" });

    const box = panel.querySelector(".visitors-box")!;
    expect(box.querySelector("h4")!.textContent).toBe("Visitantes (estimación)");
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
    expect(head).toEqual(["Código corto", "Local / sucursal", "URL", "Apertura", "Clics", "Estado", ""]);
    expect(document.querySelectorAll("#links-table thead th.hide-sm")).toHaveLength(3);
  });

  it("states the visitor caveat under the table, before any panel is opened", async () => {
    await show();

    const note = [...document.querySelectorAll(".estimate-note")].find((p) => p.querySelector("strong"));
    expect(note!.textContent).toBe(`Sobre las cifras de visitantes: ${VISITOR_ESTIMATE_CAVEAT}`);
  });
});

function button(root: Element, label: string) {
  const found = [...root.querySelectorAll("button")].find((b) => b.textContent === label);
  if (!found) throw new Error(`no ${label} button`);
  return found;
}
