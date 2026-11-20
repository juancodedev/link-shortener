import { useEffect, useState, type CSSProperties } from "react";
import { clearPrintQueue, setPrintQueued, type QueueItem } from "../print-queue";
import { CARD_MM, computeSheetLayout, presetForSize, SHEET_PRESETS, sheetPresetSize } from "./sheet";
import { reloadLinks } from "../links/reload";
import { usePrintQueue } from "./usePrintQueue";
import { api } from "../api";

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
  { value: "minimal", label: "Vidrio minimalista" },
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
  const res = await api(
    "GET",
    `/api/links/${encodeURIComponent(item.id)}/card.svg?design=${design}&variant=${variant}`,
  );
  if (!res.ok) throw new Error(`card ${item.short_code}: HTTP ${res.status}`);
  const svg = await res.text();
  svgCache.set(key, svg);
  return svg;
}

/**
 * The "Solo NFC Centrado" card prints no QR and no link (the tag is written by
 * hand afterwards), so every copy is the same SVG: one request, any amount.
 */
const nfcCache = new Map<string, Promise<string>>();

function nfcCardSvg(design: string): Promise<string> {
  // The promise is cached, not the text: typing the amount re-renders while
  // the first request is still in flight, and it must not ask again.
  const hit = nfcCache.get(design);
  if (hit !== undefined) return hit;
  const load = api("GET", `/api/cards/nfc.svg?design=${design}`).then((res) => {
    if (!res.ok) throw new Error(`nfc card: HTTP ${res.status}`);
    return res.text();
  });
  load.catch(() => nfcCache.delete(design));
  nfcCache.set(design, load);
  return load;
}

/** The typed amount of NFC cards, as a whole number; 0 when empty or invalid. */
function cardCount(value: string): number {
  const n = Math.floor(parseFloat(value));
  return Number.isNaN(n) || n < 0 ? 0 : n;
}

type Cards = { status: "loading" } | { status: "error" } | { status: "ready"; svgs: string[] };

export function CardsSection() {
  const queue = usePrintQueue();
  const [variant, setVariant] = useState<string>("hybrid");
  const [count, setCount] = useState("1");
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
  const nfcOnly = variant === "nfc";
  // NFC-only cards ignore the queue: the user says how many they need.
  const total = nfcOnly ? cardCount(count) : queue.length;
  const layout = computeSheetLayout(size.w, size.h, sheetMargin, sheetGap, total);

  useEffect(() => {
    if (total === 0) return;
    let current = true;
    setCards({ status: "loading" });
    const load = nfcOnly
      ? nfcCardSvg(design).then((svg) => Array<string>(total).fill(svg))
      : Promise.all(queue.map((item) => cardSvg(item, design, variant)));
    load.then(
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
  }, [queue, design, variant, nfcOnly, total]);

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
    if (total === 0) return;
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
    if (!window.confirm(`¿Marcar ${queue.length} tarjeta(s) como impresas? Aparecerán como impresas en Enlaces.`)) return;
    setMarking(true);
    void (async () => {
      try {
        // One request per print run, never one per card: the queue itself is
        // page state, and this is what survives a reload.
        await api("POST", "/api/links/printed", { ids: queue.map((item) => item.id) });
        clearPrintQueue();
        // The rows carry the new printed_at: reload once, not per card.
        void reloadLinks();
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
  if (nfcOnly && total === 0) {
    sheets = <p className="gate-empty">Indica cuántas tarjetas Solo NFC necesitas.</p>;
  } else if (total === 0) {
    sheets = <p className="gate-empty">No hay tarjetas por imprimir. Envía a imprimir enlaces sin configurar desde la sección Enlaces.</p>;
  } else if (!layout.fits) {
    info = `La hoja es demasiado pequeña para una tarjeta de ${CARD_MM}×${CARD_MM} mm con ese margen.`;
  } else {
    info = `${layout.cols}×${layout.rows} = ${layout.cap} tarjetas por hoja · tarjetas de ${CARD_MM}×${CARD_MM} mm · ${total} tarjeta(s) · ${layout.pages} hoja(s)`;
    if (cards.status === "error") {
      sheets = <p className="gate-empty">No se pudieron cargar las tarjetas.</p>;
    } else if (cards.status === "ready" && cards.svgs.length === total) {
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
      <h3>Tarjetas por imprimir</h3>
      <p className="field-help">
        Los enlaces que envías a imprimir desde la sección Enlaces esperan aquí. Una tarjeta sale de la cola cuando la marcas
        como impresa, la quitas o guardas su destino. La cola vive solo en esta página: al recargarla, empieza vacía.
      </p>
      {!nfcOnly && (
        <ul id="cards-queue" className="cards-queue">
          {queue.map((item) => (
            <li key={item.id}>
              <span className="code">{item.short_code}</span>
              <button type="button" className="btn-sm btn-outline" onClick={() => setPrintQueued(item.id, false)}>
                Quitar
              </button>
            </li>
          ))}
        </ul>
      )}
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
          {nfcOnly && (
            <>
              <label className="gap-top-sm">
                Cantidad de tarjetas
                <input id="card-count" type="number" min="1" step="1" value={count} onChange={(e) => setCount(e.target.value)} />
              </label>
              <p className="field-help">Sin QR ni enlace: el NFC lo grabas tú después de imprimir.</p>
            </>
          )}
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
        <button type="button" id="cards-export" className="btn-sm btn-primary" disabled={total === 0} onClick={exportCards}>
          Exportar PDF / Imprimir
        </button>
        {!nfcOnly && (
          <button
            type="button"
            id="cards-mark-printed"
            className="btn-sm btn-outline"
            disabled={queue.length === 0 || marking}
            onClick={markPrinted}
          >
            Marcar como impresas
          </button>
        )}
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
