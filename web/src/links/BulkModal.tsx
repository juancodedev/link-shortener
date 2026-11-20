import { useState } from "react";
import { errorText, type Link } from "./load";
import { api } from "../api";

/**
 * MANUFACTURING CARD STOCK IN BULK (dashboard-react T3b).
 *
 * The "Create cards in bulk..." button and the modal it opens. The cards are
 * created WITHOUT a destination, which is the state the whole flow depends on:
 * the QR goes on the card now and the URL is loaded later, when it is settled.
 *
 * The modal asks for a count, one label for the batch and the review-screen
 * choice, nothing else: every other field on a link is per-card by nature and
 * stays editable on the row.
 *
 * It renders as a fixed overlay (.qr-modal), so where it sits in the DOM does
 * not change what the owner sees, and the print CSS hides it.
 */

type Message = { kind: "" | "success" | "error"; text: string };

/** One item of the POST /api/links/batch answer. */
type BatchResult = { status: number; link?: Link; error?: string };

export function BulkModal({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  // The fields keep their values between openings, as the server-rendered
  // inputs did; only the result of the last run is dropped.
  const [count, setCount] = useState("10");
  const [label, setLabel] = useState("");
  const [gated, setGated] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Message>({ kind: "", text: "" });
  /** The summary of the last run, or null while there is none to show. */
  const [summary, setSummary] = useState<string | null>(null);
  // The ids the sheet is built from: only the cards that were really created.
  const [ids, setIds] = useState<string[]>([]);

  function openModal() {
    setIds([]);
    setSummary(null);
    setMsg({ kind: "", text: "" });
    setOpen(true);
  }

  async function create() {
    const n = parseInt(count, 10);
    // Validated here as well as on the server: the server is what makes it
    // safe, but a button that waits ten seconds to refuse a 0 teaches the
    // owner the button is broken.
    if (!Number.isInteger(n) || n < 1 || n > 200) {
      setMsg({ kind: "error", text: "Ingresa un número entre 1 y 200." });
      return;
    }

    setBusy(true);
    setMsg({ kind: "", text: "" });

    try {
      // ONE label for the whole run: the question is "where does this batch
      // go", not ten separate identities. A blank one is no label at all,
      // never ten cards carrying an empty identifier.
      const ref = label.trim();
      const links = Array.from({ length: n }, () => ({
        is_gated: gated,
        ...(ref ? { client_ref: ref } : {}),
      }));
      const res = await api("POST", "/api/links/batch", { links });

      const body = (await res.json()) as { results?: BatchResult[]; error?: string };
      // A partial batch is reported, never treated as success: nine of ten
      // cards is a shortfall the owner discovers at the printer.
      const results = body.results || [];
      const created = results.filter((r) => r.status === 201);
      if (!res.ok && !created.length) throw new Error(body.error || "No se pudieron crear las tarjetas");

      setIds(created.map((r) => r.link!.id));
      const failed = results.length - created.length;
      setSummary(
        created.length +
          (created.length === 1 ? " tarjeta creada. " : " tarjetas creadas. ") +
          (failed ? failed + (failed === 1 ? " falló; reinténtala." : " fallaron; reinténtalas.") : ""),
      );
      setMsg({ kind: failed ? "error" : "success", text: "" });
      onCreated();
    } catch (err) {
      setMsg({ kind: "error", text: errorText(err) || "Error" });
    } finally {
      setBusy(false);
    }
  }

  async function download() {
    if (!ids.length) {
      setMsg({ kind: "error", text: "Primero crea las tarjetas." });
      return;
    }

    try {
      // Through api(), never a hand-rolled fetch: an earlier version read the
      // token from the wrong place and the sheet 401'd after the cards had
      // been created. api() returns the response, so the blob comes through
      // unchanged, with the 401 redirect and the tenant picker included.
      const res = await api("POST", "/api/links/qr-sheet.zip", { link_ids: ids });

      const blob = await res.blob();
      const href = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = href;
      a.download = "tarjetas.zip";
      document.body.appendChild(a);
      a.click();
      a.remove();
      // The click already handed the download to the browser; a live object
      // URL would pin the whole ZIP in memory for the life of the tab.
      URL.revokeObjectURL(href);
    } catch (err) {
      setMsg({ kind: "error", text: errorText(err) || "Error" });
    }
  }

  return (
    <>
      <button type="button" id="open-bulk" className="btn-sm btn-outline" onClick={openModal}>
        Crear tarjetas en lote…
      </button>
      <div id="bulk-modal" className={open ? "qr-modal" : "qr-modal hidden"} onClick={() => setOpen(false)}>
        <div className="qr-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: "26rem" }}>
          <h3 className="qr-title">Crear tarjetas en lote</h3>
          <p className="field-help">
            Cada tarjeta recibe su propio QR y aún no tiene destino. Imprímelas y carga la URL real cuando esté definida; mientras
            tanto, escanear una tarjeta abre una página "sin configurar" en lugar de un enlace roto.
          </p>
          <label htmlFor="bulk-count">Cuántas tarjetas</label>
          <input type="number" id="bulk-count" min="1" max="200" step="1" value={count} onChange={(e) => setCount(e.target.value)} />
          <label htmlFor="bulk-label" className="gap-top-sm">
            Etiqueta para este lote <span className="field-note">(opcional)</span>
          </label>
          <input
            type="text"
            id="bulk-label"
            maxLength={200}
            placeholder="p. ej. Salón principal — mesas 1 a 10"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
          <label className="check-row gap-top-sm">
            <input type="checkbox" id="bulk-gated" checked={gated} onChange={(e) => setGated(e.target.checked)} />
            <span>Mostrar la pantalla de reseña antes de redirigir</span>
          </label>
          <p className="field-help">
            Desactivado: una vez cargado el destino, los escaneos van directo a él. Activado: tus clientes ven la calificación con
            estrellas y pueden dejar un comentario privado, y solo estas tarjetas alimentan el panel de satisfacción. Puedes cambiarlo
            por tarjeta después.
          </p>
          <p className="field-help">
            Se imprime bajo el código de cada tarjeta y se escribe en el CSV de la hoja, para que el diseñador sepa qué adhesivo es
            cuál antes de cortar. Un solo campo para todo el lote es mejor que escribirlo diez veces.
          </p>
          <div id="bulk-msg" className={msg.kind ? `message ${msg.kind}` : "message"}>
            {msg.text}
          </div>
          <div id="bulk-result" style={{ display: summary === null ? "none" : "" }}>
            <p className="caption" id="bulk-summary">
              {summary}
            </p>
            <button type="button" id="bulk-download" className="btn-sm btn-primary gap-top-sm" onClick={() => void download()}>
              Descargar hoja de impresión (.zip)
            </button>
            <p className="field-help">Un SVG por tarjeta más un links.csv que las enumera. Las tarjetas van directo a tu diseñador.</p>
          </div>
          <div className="gap-top-sm" style={{ display: "flex", gap: ".5rem" }}>
            <button type="button" id="bulk-create" className="btn-sm btn-primary" disabled={busy} onClick={() => void create()}>
              {busy ? "Creando…" : "Crearlas"}
            </button>
            <button type="button" className="btn-sm gap-top-sm" onClick={() => setOpen(false)}>
              Cerrar
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
