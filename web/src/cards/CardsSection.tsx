import { useEffect, useState, type CSSProperties } from "react";
import type { QueueItem } from "../legacy";
import { CARD_MM, computeSheetLayout, presetForSize, SHEET_PRESETS, sheetPresetSize } from "./sheet";
import { usePrintQueue } from "./usePrintQueue";

/**
 * THE PRINT QUEUE (odd/tasks/print-queue-cards.md S4-S6, dashboard-react T2).
 *
 * Every link sent to print from the Links section, laid out as 10×10 cm
 * review cards on the chosen sheet. The sheet IS the print: same SVG, same
 * millimetres; only the screen preview is zoomed. Cards start at the
 * top-left margin so a part-used sheet can go through the printer again.
 *
 * Renders inside the server-rendered `#cards-root`, keeping its ids and
 * classes, so the dashboard's CSS (grid, zoom, print rules) applies as is.
 */

const VARIANTS = [
  { value: "hybrid", label: "Híbrido: QR + NFC" },
  { value: "qr", label: "Solo QR Centrado" },
  { value: "nfc", label: "Solo NFC Centrado" },
] as const;

const DESIGNS = [
  { value: "official", label: "Estándar Oficial Google" },
  { value: "minimal", label: "Clean Minimalist Glass" },
] as const;

const PRESET_VALUES = SHEET_PRESETS.map((p) => p.value);

/** A typed millimetre value, or the default when it is empty, invalid or negative. */
function mm(value: string, fallback: number): number {
  const v = parseFloat(value);
  return Number.isNaN(v) || v < 0 ? fallback : v;
}

/** Card SVGs by link, design and variant: switching options back costs no request. */
const svgCache = new Map<string, string>();

async function cardSvg(item: QueueItem, design: string, variant: string): Promise<string> {
  const key = `${item.id}|${design}|${variant}`;
  const hit = svgCache.get(key);
  if (hit !== undefined) return hit;
  const res = await window.__api(
    "GET",
    `/api/links/${encodeURIComponent(item.id)}/card.svg?design=${design}&variant=${variant}`,
  );
  if (!res.ok) throw new Error(`card ${item.short_code}: HTTP ${res.status}`);
  const svg = await res.text();
  svgCache.set(key, svg);
  return svg;
}

type Cards = { status: "loading" } | { status: "error" } | { status: "ready"; svgs: string[] };

export function CardsSection() {
  const queue = usePrintQueue();
  const [variant, setVariant] = useState<string>("hybrid");
  const [design, setDesign] = useState<string>("official");
  const [mirror, setMirror] = useState(false);
  const [crop, setCrop] = useState(true);
  const [preset, setPreset] = useState<string>("297x420");
  const [margin, setMargin] = useState("10");
  const [gap, setGap] = useState("6");
  const [width, setWidth] = useState("297");
  const [height, setHeight] = useState("420");
  const [zoom, setZoom] = useState("45");
  const [cards, setCards] = useState<Cards>({ status: "loading" });
  const [marking, setMarking] = useState(false);

  const size = sheetPresetSize(preset, mm(width, 600), mm(height, 400));
  const sheetMargin = size.single ? 0 : mm(margin, 10);
  const sheetGap = size.single ? 0 : mm(gap, 6);
  const layout = computeSheetLayout(size.w, size.h, sheetMargin, sheetGap, queue.length);

  useEffect(() => {
    if (queue.length === 0) return;
    let current = true;
    setCards({ status: "loading" });
    Promise.all(queue.map((item) => cardSvg(item, design, variant))).then(
      (svgs) => {
        if (current) setCards({ status: "ready", svgs });
      },
      (err: unknown) => {
        if (!current) return;
        setCards({ status: "error" });
        console.error("cards failed to load", err);
      },
    );
    return () => {
      current = false;
    };
  }, [queue, design, variant]);

  useEffect(() => {
    const afterPrint = () => {
      document.body.classList.remove("printing-cards");
      const style = document.getElementById("card-page-style");
      if (style) style.textContent = "";
    };
    window.addEventListener("afterprint", afterPrint);
    return () => window.removeEventListener("afterprint", afterPrint);
  }, []);

  function choosePreset(value: string) {
    setPreset(value);
    if (value === "custom") return;
    const chosen = sheetPresetSize(value, 0, 0);
    setWidth(String(chosen.w));
    setHeight(String(chosen.h));
  }

  function typeSize(w: string, h: string) {
    setWidth(w);
    setHeight(h);
    setPreset(presetForSize(parseFloat(w), parseFloat(h), PRESET_VALUES));
  }

  /**
   * Prints only the sheets, at the sheet size with no page margin (S5).
   * The @page rule and the body class exist just for this print and are
   * removed afterwards, so "Print report" keeps the browser's page.
   */
  function exportCards() {
    if (queue.length === 0) return;
    let style = document.getElementById("card-page-style");
    if (!style) {
      style = document.createElement("style");
      style.id = "card-page-style";
      document.head.appendChild(style);
    }
    // One millimetre shorter on paper: a sheet exactly the page height can
    // spill a blank page in some print engines.
    style.textContent =
      `@page { size: ${size.w}mm ${size.h}mm; margin: 0; }` +
      ` @media print { .card-sheet { height: ${size.single ? size.h : size.h - 1}mm !important; } }`;
    document.body.classList.add("printing-cards");
    window.print();
  }

  function markPrinted() {
    if (queue.length === 0 || marking) return;
    if (!window.confirm(`Mark ${queue.length} card(s) as printed? They will show as printed in Links.`)) return;
    setMarking(true);
    void (async () => {
      try {
        // One request per print run, never one per card: the queue itself is
        // page state, and this is what survives a reload.
        await window.__api("POST", "/api/links/printed", { ids: queue.map((item) => item.id) });
        window.__clearPrintQueue();
        // The rows carry the new printed_at: reload once, not per card.
        void window.__loadLinks?.();
      } catch (err) {
        // Nothing was recorded, so the batch stays where it is.
        window.alert("Error: " + (err instanceof Error ? err.message : ""));
      } finally {
        setMarking(false);
      }
    })();
  }

  let info = "";
  let sheets: React.ReactNode = null;
  if (queue.length === 0) {
    sheets = <p className="gate-empty">No cards waiting to be printed. Send unconfigured links to print from the Links section.</p>;
  } else if (!layout.fits) {
    info = `The sheet is too small for a ${CARD_MM}×${CARD_MM} mm card with that margin.`;
  } else {
    info = `${layout.cols}×${layout.rows} = ${layout.cap} cards per sheet · ${CARD_MM}×${CARD_MM} mm cards · ${queue.length} card(s) · ${layout.pages} sheet(s)`;
    if (cards.status === "error") {
      sheets = <p className="gate-empty">Could not load the cards.</p>;
    } else if (cards.status === "ready" && cards.svgs.length === queue.length) {
      const pages: string[][] = [];
      cards.svgs.forEach((svg, i) => {
        if (i % layout.cap === 0) pages.push([]);
        pages[pages.length - 1]!.push(svg);
      });
      const cardClass = "print-card" + (mirror ? " is-mirror" : "") + (crop ? " is-crop" : "");
      sheets = pages.map((page, p) => (
        <div
          key={p}
          className="card-sheet"
          style={{
            width: `${size.w}mm`,
            height: `${size.h}mm`,
            padding: `${sheetMargin}mm`,
            gap: `${sheetGap}mm`,
            gridTemplateColumns: `repeat(${layout.cols}, ${CARD_MM}mm)`,
            gridAutoRows: `${CARD_MM}mm`,
          }}
        >
          {page.map((svg, i) => (
            // The SVG comes from our own card renderer (src/cards/render.ts),
            // which escapes every value it draws.
            <div key={i} className={cardClass} dangerouslySetInnerHTML={{ __html: svg }} />
          ))}
        </div>
      ));
    }
  }

  return (
    <>
      <h3>Cards to print</h3>
      <p className="field-help">
        Links you send to print from the Links section wait here. A card leaves the queue when you mark it printed,
        remove it, or save its destination. The queue lives in this page only: reloading it starts empty.
      </p>
      <ul id="cards-queue" className="cards-queue">
        {queue.map((item) => (
          <li key={item.id}>
            <span className="code">{item.short_code}</span>
            <button type="button" className="btn-sm btn-outline" onClick={() => window.__setPrintQueued(item.id, false)}>
              Remove
            </button>
          </li>
        ))}
      </ul>
      <div id="cards-controls" className="cards-controls">
        <fieldset>
          <legend>Variante</legend>
          {VARIANTS.map((v) => (
            <label key={v.value} className="check-row">
              <input
                type="radio"
                name="card-variant"
                value={v.value}
                checked={variant === v.value}
                onChange={() => setVariant(v.value)}
              />
              {v.label}
            </label>
          ))}
        </fieldset>
        <fieldset>
          <legend>Diseño</legend>
          <select id="card-design" aria-label="Diseño" value={design} onChange={(e) => setDesign(e.target.value)}>
            {DESIGNS.map((d) => (
              <option key={d.value} value={d.value}>
                {d.label}
              </option>
            ))}
          </select>
          <label className="check-row">
            <input type="checkbox" id="card-mirror" checked={mirror} onChange={(e) => setMirror(e.target.checked)} />
            Modo Espejo (impresión posterior transparente)
          </label>
          <label className="check-row">
            <input type="checkbox" id="card-crop" checked={crop} onChange={(e) => setCrop(e.target.checked)} />
            Líneas / Guías de Corte (Radio R5)
          </label>
        </fieldset>
        <fieldset>
          <legend>Hoja</legend>
          <select id="card-sheet" aria-label="Hoja" value={preset} onChange={(e) => choosePreset(e.target.value)}>
            {SHEET_PRESETS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
          <div className="cards-mm">
            <label>
              Margen hoja (mm)
              <input id="card-margin" type="number" min="0" value={margin} onChange={(e) => setMargin(e.target.value)} />
            </label>
            <label>
              Separación (mm)
              <input id="card-gap" type="number" min="0" value={gap} onChange={(e) => setGap(e.target.value)} />
            </label>
            <label>
              Ancho hoja (mm)
              <input id="card-sheet-w" type="number" min="100" value={width} onChange={(e) => typeSize(e.target.value, height)} />
            </label>
            <label>
              Alto hoja (mm)
              <input id="card-sheet-h" type="number" min="100" value={height} onChange={(e) => typeSize(width, e.target.value)} />
            </label>
          </div>
          <label className="gap-top-sm">
            Zoom vista previa
            <input id="card-zoom" type="range" min="25" max="100" value={zoom} onChange={(e) => setZoom(e.target.value)} />
          </label>
        </fieldset>
      </div>
      <div className="cards-actions">
        <button type="button" id="cards-export" className="btn-sm btn-primary" disabled={queue.length === 0} onClick={exportCards}>
          Export PDF / Print
        </button>
        <button
          type="button"
          id="cards-mark-printed"
          className="btn-sm btn-outline"
          disabled={queue.length === 0 || marking}
          onClick={markPrinted}
        >
          Mark as printed
        </button>
        <span id="cards-info" className="cards-info">
          {info}
        </span>
      </div>
      <div
        id="card-sheets"
        style={{ "--card-zoom": String(Number(zoom) / 100), "--card-size": `${CARD_MM}mm` } as CSSProperties}
      >
        {sheets}
      </div>
    </>
  );
}
