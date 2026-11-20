import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CardsSection } from "../../src/cards/CardsSection";
import { CARD_MM, SHEET_PRESETS } from "../../src/cards/sheet";
import { clearPrintQueue, getPrintQueue, setPrintQueued, type QueueItem } from "../../src/print-queue";
import { provideLinksLoad } from "../../src/links/reload";
import { stubApi } from "../api-stub";

type Calls = { api: string[]; requests: Array<{ method: string; path: string; body?: unknown }> };

/** Fills the real print queue (web/src/print-queue) and stubs the API. */
function queueWith(queue: QueueItem[], svg = (path: string) => `<svg data-path="${path}"></svg>`) {
  const calls: Calls = { api: [], requests: [] };
  clearPrintQueue();
  for (const item of queue) setPrintQueued(item.id, true, item.short_code);
  stubApi(vi.fn(async (method: string, path: string, body?: unknown) => {
    calls.api.push(path);
    calls.requests.push({ method, path, body });
    return new Response(svg(path), { status: 200 });
  }));
  return calls;
}

async function mount() {
  const view = render(<CardsSection />);
  await act(async () => {});
  return view;
}

const field = (id: string) => document.getElementById(id) as HTMLInputElement & HTMLSelectElement;

describe("Cards section (React)", () => {
  beforeEach(() => {
    vi.stubGlobal("print", vi.fn());
    vi.stubGlobal("confirm", vi.fn(() => true));
    vi.stubGlobal("alert", vi.fn());
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    document.getElementById("card-page-style")?.remove();
    document.body.className = "";
  });

  it("offers every option of the original generator, with the Chilean Oficio sheet", async () => {
    queueWith([]);
    await mount();

    for (const v of ["hybrid", "qr", "nfc"]) expect(document.querySelector(`input[name="card-variant"][value="${v}"]`)).not.toBeNull();
    expect(screen.getByLabelText("Híbrido: QR + NFC")).toBeChecked();
    screen.getByLabelText("Solo QR Centrado");
    screen.getByLabelText("Solo NFC Centrado");
    expect([...field("card-design").options].map((o) => o.text)).toEqual(["Estándar Oficial Google", "Vidrio minimalista"]);
    expect([...field("card-sheet").options].map((o) => [o.value, o.text])).toEqual([
      ["297x420", "A3 vertical (297×420 mm)"],
      ["420x297", "A3 horizontal (420×297 mm)"],
      ["210x297", "A4 vertical (210×297 mm)"],
      ["297x210", "A4 horizontal (297×210 mm)"],
      ["216x279", "Carta (216×279 mm)"],
      ["216x330", "Oficio (216×330 mm)"],
      ["100x100", "1 tarjeta por hoja (100×100 mm)"],
      ["custom", "Medida personalizada (rollo / pliego)"],
    ]);
    expect(screen.getByLabelText(/Modo Espejo/)).not.toBeChecked();
    expect(screen.getByLabelText(/Líneas \/ Guías de Corte/)).toBeChecked();
    expect(field("card-margin").value).toBe("10");
    expect(field("card-gap").value).toBe("6");
    expect(field("card-zoom").value).toBe("45");
  });

  it("shows the selected sheet's size in editable fields and keeps the selector in step with typed sizes", async () => {
    queueWith([]);
    await mount();

    expect([field("card-sheet-w").value, field("card-sheet-h").value]).toEqual(["297", "420"]);
    expect(field("card-sheet-w").disabled).toBe(false);

    fireEvent.change(field("card-sheet"), { target: { value: "216x330" } });
    expect([field("card-sheet-w").value, field("card-sheet-h").value]).toEqual(["216", "330"]);

    fireEvent.change(field("card-sheet-h"), { target: { value: "279" } });
    expect(field("card-sheet").value).toBe("216x279");

    fireEvent.change(field("card-sheet-w"), { target: { value: "500" } });
    expect(field("card-sheet").value).toBe("custom");
    expect([field("card-sheet-w").value, field("card-sheet-h").value]).toEqual(["500", "279"]);
  });

  it("says the queue is empty and disables both actions", async () => {
    queueWith([]);
    await mount();

    screen.getByText("No hay tarjetas por imprimir. Envía a imprimir enlaces sin configurar desde la sección Enlaces.");
    expect(screen.getByRole("button", { name: "Exportar PDF / Imprimir" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Marcar como impresas" })).toBeDisabled();
  });

  it("lays the queued cards out from the top-left of each sheet, drawn by the API", async () => {
    const calls = queueWith([
      { id: "a", short_code: "AAA" },
      { id: "b/2", short_code: "BBB" },
      { id: "c", short_code: "CCC" },
    ]);
    await mount();
    fireEvent.change(field("card-sheet"), { target: { value: "210x297" } });
    fireEvent.click(screen.getByLabelText(/Modo Espejo/));
    fireEvent.change(field("card-design"), { target: { value: "minimal" } });
    fireEvent.click(screen.getByLabelText("Solo QR Centrado"));
    await act(async () => {});

    expect(calls.api).toContain("/api/links/b%2F2/card.svg?design=minimal&variant=qr");
    screen.getByText("1×2 = 2 tarjetas por hoja · tarjetas de 100×100 mm · 3 tarjeta(s) · 2 hoja(s)");
    const sheets = [...document.querySelectorAll<HTMLElement>("#card-sheets > .card-sheet")];
    expect(sheets).toHaveLength(2);
    expect(sheets[0]!.style.width).toBe("210mm");
    expect(sheets[0]!.style.height).toBe("297mm");
    expect(sheets[0]!.style.padding).toBe("10mm");
    expect(sheets[0]!.style.gap).toBe("6mm");
    expect(sheets[0]!.style.gridTemplateColumns).toBe("repeat(1, 100mm)");
    expect(sheets.map((s) => s.querySelectorAll(".print-card").length)).toEqual([2, 1]);
    const card = sheets[0]!.querySelector(".print-card")!;
    expect(card.className).toBe("print-card is-mirror is-crop");
    expect(card.querySelector("svg")!.getAttribute("data-path")).toBe("/api/links/a/card.svg?design=minimal&variant=qr");
  });

  it("drops the margin and gap on the one-card sheet", async () => {
    queueWith([{ id: "a", short_code: "AAA" }]);
    await mount();
    fireEvent.change(field("card-sheet"), { target: { value: "100x100" } });
    await act(async () => {});

    const sheet = document.querySelector<HTMLElement>(".card-sheet")!;
    expect(sheet.style.padding).toBe("0mm");
    screen.getByText("1×1 = 1 tarjetas por hoja · tarjetas de 100×100 mm · 1 tarjeta(s) · 1 hoja(s)");
  });

  it("lays A4 landscape out as two cards side by side", async () => {
    queueWith([{ id: "a", short_code: "AAA" }]);
    await mount();
    fireEvent.change(field("card-sheet"), { target: { value: "297x210" } });
    await act(async () => {});

    const sheet = document.querySelector<HTMLElement>(".card-sheet")!;
    expect([sheet.style.width, sheet.style.height]).toEqual(["297mm", "210mm"]);
    expect(sheet.style.gridTemplateColumns).toBe("repeat(2, 100mm)");
    screen.getByText("2×1 = 2 tarjetas por hoja · tarjetas de 100×100 mm · 1 tarjeta(s) · 1 hoja(s)");
  });

  it("keeps every card at 10×10 cm on every sheet preset", async () => {
    queueWith([{ id: "a", short_code: "AAA" }]);
    await mount();

    for (const p of SHEET_PRESETS) {
      fireEvent.change(field("card-sheet"), { target: { value: p.value } });
      if (p.value === "custom") {
        fireEvent.change(field("card-sheet-w"), { target: { value: "200" } });
        fireEvent.change(field("card-sheet-h"), { target: { value: "200" } });
      }
      await act(async () => {});
      const sheet = document.querySelector<HTMLElement>(".card-sheet")!;
      expect(sheet.style.gridTemplateColumns, p.value).toMatch(new RegExp(`, ${CARD_MM}mm\\)$`));
      expect(sheet.style.gridAutoRows, p.value).toBe(`${CARD_MM}mm`);
    }
  });

  it("says when the sheet is too small for a card with that margin", async () => {
    queueWith([{ id: "a", short_code: "AAA" }]);
    await mount();
    fireEvent.change(field("card-sheet"), { target: { value: "custom" } });
    fireEvent.change(field("card-sheet-w"), { target: { value: "150" } });
    fireEvent.change(field("card-sheet-h"), { target: { value: "150" } });
    fireEvent.change(field("card-margin"), { target: { value: "30" } });
    await act(async () => {});

    screen.getByText("La hoja es demasiado pequeña para una tarjeta de 100×100 mm con ese margen.");
    expect(document.querySelectorAll(".card-sheet")).toHaveLength(0);
  });

  it("says when the cards could not be loaded", async () => {
    queueWith([{ id: "never-loaded", short_code: "NOPE" }]);
    stubApi(vi.fn(async () => new Response("nope", { status: 500 })));
    vi.spyOn(console, "error").mockImplementation(() => {});
    await mount();

    screen.getByText("No se pudieron cargar las tarjetas.");
  });

  it("scales only the preview through --card-zoom", async () => {
    queueWith([]);
    await mount();
    fireEvent.change(field("card-zoom"), { target: { value: "80" } });

    expect(document.getElementById("card-sheets")!.style.getPropertyValue("--card-zoom")).toBe("0.8");
  });

  it("follows the queue the Links table changes", async () => {
    queueWith([]);
    await mount();

    await act(async () => {
      setPrintQueued("a", true, "AAA");
    });

    expect(screen.getByRole("listitem").textContent).toContain("AAA");
    expect(document.querySelectorAll(".print-card")).toHaveLength(1);
  });

  it("removes one card from the shared queue", async () => {
    queueWith([{ id: "a", short_code: "AAA" }, { id: "b", short_code: "BBB" }]);
    await mount();
    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: "Quitar" })[0]!);
    });

    expect(getPrintQueue()).toEqual([{ id: "b", short_code: "BBB" }]);
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
  });

  it("records the print run before emptying the batch, then refreshes Links", async () => {
    const calls = queueWith([{ id: "a", short_code: "AAA" }, { id: "b", short_code: "BBB" }]);
    const reload = vi.fn(async () => {});
    const stop = provideLinksLoad(reload);
    await mount();
    const svgCalls = calls.api.length;

    vi.mocked(window.confirm).mockReturnValueOnce(false);
    fireEvent.click(screen.getByRole("button", { name: "Marcar como impresas" }));
    expect(getPrintQueue()).toHaveLength(2);
    expect(calls.requests.slice(svgCalls)).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "Marcar como impresas" }));
    await act(async () => {});

    expect(window.confirm).toHaveBeenLastCalledWith(
      "¿Marcar 2 tarjeta(s) como impresas? Aparecerán como impresas en Enlaces.",
    );
    expect(calls.requests.slice(svgCalls)).toEqual([
      { method: "POST", path: "/api/links/printed", body: { ids: ["a", "b"] } },
    ]);
    expect(getPrintQueue()).toEqual([]);
    expect(reload).toHaveBeenCalledTimes(1);
    stop();
  });

  it("keeps the batch when the print run could not be recorded", async () => {
    const calls = queueWith([{ id: "a", short_code: "AAA" }]);
    stubApi(vi.fn(async () => {
      throw new Error("network down");
    }));
    await mount();

    fireEvent.click(screen.getByRole("button", { name: "Marcar como impresas" }));
    await act(async () => {});

    expect(getPrintQueue()).toEqual([{ id: "a", short_code: "AAA" }]);
    expect(screen.getByRole("listitem").textContent).toContain("AAA");
    expect(window.alert).toHaveBeenCalledWith("Error: network down");
  });

  it("prints only the sheets, with the page at the sheet size and no margin", async () => {
    queueWith([{ id: "a", short_code: "AAA" }]);
    await mount();
    fireEvent.change(field("card-sheet"), { target: { value: "216x330" } });
    fireEvent.click(screen.getByRole("button", { name: "Exportar PDF / Imprimir" }));

    expect(window.print).toHaveBeenCalledTimes(1);
    expect(document.body.classList.contains("printing-cards")).toBe(true);
    expect(document.getElementById("card-page-style")!.textContent).toBe(
      "@page { size: 216mm 330mm; margin: 0; } @media print { .card-sheet { height: 329mm !important; } }",
    );

    window.dispatchEvent(new Event("afterprint"));
    expect(document.body.classList.contains("printing-cards")).toBe(false);
    expect(document.getElementById("card-page-style")!.textContent).toBe("");
  });
});
