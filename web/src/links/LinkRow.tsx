import { useEffect, useRef, useState } from "react";
import { VISITOR_ESTIMATE_CAVEAT } from "../../../src/analytics/metrics";
import { announceOverviewChange } from "../overview/changes";
import { setPrintQueued } from "../print-queue";
import { branchOptions, type BranchList } from "./branches";
import { errorText, type ClickMetrics, type Link } from "./load";
import { api } from "../api";
import { LOCALE, spanishWindow } from "../format";

/**
 * One link as its two table rows: the row itself and its editing panel.
 *
 * Every record value reaches the page as JSX text or an attribute React sets
 * through the DOM, never as markup: short_code, original_url, client_ref,
 * business and branch names and the click-breakdown keys are all typed by a
 * person or carried in request data (a Referer can hold arbitrary text).
 *
 * The fields keep their own draft values, so repainting this link after a
 * save leaves unsaved typing in the other fields alone; the saved field shows
 * what the server stored.
 */

export type MetricsState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: ClickMetrics };

export type LinkRowProps = {
  link: Link;
  queued: boolean;
  open: boolean;
  metrics: MetricsState | undefined;
  branches: BranchList;
  /** The clicks count: opens or closes the panel. */
  onTogglePanel: (id: string) => void;
  /** The Edit button: opens the panel (never closes it) and focuses the destination. */
  onEdit: (id: string) => void;
  /** Applies a saved change to this link only. */
  onRepaint: (id: string, changes: Partial<Link>) => void;
  /** Reloads the whole table (after a delete). */
  onReload: () => void;
  /** Opens the QR modal for this raw short URL (the modal encodes it, exactly once). */
  onShowQR: (shortUrl: string) => void;
};

const PATCH = (id: string, body: Record<string, unknown>) =>
  api("PATCH", `/api/links/${encodeURIComponent(id)}`, body);

function linkStatus(l: Link): "inactive" | "expired" | "active" {
  if (!l.is_active) return "inactive";
  if (l.expires_at && new Date(l.expires_at) < new Date()) return "expired";
  return "active";
}

/** The badge text per status; the class keeps the English key the CSS is written against. */
const STATUS_LABEL: Record<ReturnType<typeof linkStatus>, string> = {
  active: "Activo",
  inactive: "Inactivo",
  expired: "Vencido",
};

/** "Impresa el 19 nov 2026, 12:00" — the run behind the badge, kept out of the cell. */
function printedTitle(iso: string): string {
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return `Impresa el ${iso}`;
  return `Impresa el ${when.toLocaleString(LOCALE, { dateStyle: "medium", timeStyle: "short" })}`;
}

export function LinkRow({ link: l, queued, open, metrics, branches, onTogglePanel, onEdit, onRepaint, onReload, onShowQR }: LinkRowProps) {
  const shortUrl = l.short_url || "";
  const [clientRef, setClientRef] = useState(l.client_ref ?? "");
  const [destination, setDestination] = useState(l.original_url ?? "");
  const [branch, setBranch] = useState(l.location_id ?? "");
  // An unsaved pick that a branches reload took out of the list falls back to
  // the stored branch, as the legacy picker rebuild did: a select showing a
  // value it no longer offers would Save something nobody can see.
  const pickerOptions = branchOptions(l.location_id ?? "", branches.all, branches.businesses);
  const shownBranch = pickerOptions.some((o) => o.value === branch) ? branch : (l.location_id ?? "");
  const [gated, setGatedBox] = useState(Boolean(l.is_gated));
  const [gateBusy, setGateBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(copiedTimer.current), []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(shortUrl);
    } catch {
      // Fallback for browsers that refuse the clipboard API.
      const input = document.createElement("input");
      input.value = shortUrl;
      document.body.appendChild(input);
      input.select();
      document.execCommand("copy");
      document.body.removeChild(input);
    }
    setCopied(true);
    clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopied(false), 1500);
  }

  async function toggleActive() {
    const active = !l.is_active;
    try {
      const res = await PATCH(l.id, { is_active: active });
      if (!res.ok) throw new Error("No se pudo completar la acción");
      onRepaint(l.id, { is_active: active });
    } catch (err) {
      alert("Error: " + errorText(err));
    }
  }

  /**
   * The review-screen choice. The click already flipped the box, so the
   * request is the only wait: no table reload. On failure the box and its
   * note go back to the state the server still holds. The server
   * invalidates the cached redirect, so the next scan follows the new choice.
   */
  async function saveGated(next: boolean) {
    setGatedBox(next);
    setGateBusy(true);
    try {
      const res = await PATCH(l.id, { is_gated: next });
      if (!res.ok) throw new Error("No se pudo completar la acción");
      onRepaint(l.id, { is_gated: next });
    } catch (err) {
      setGatedBox(!next);
      alert("Error: " + errorText(err));
    } finally {
      setGateBusy(false);
    }
  }

  // An emptied field is sent as null, so clearing the identifier removes it
  // rather than storing an empty string that would never match a CRM record.
  async function saveClientRef() {
    const value = clientRef.trim();
    const stored = value === "" ? null : value;
    try {
      const res = await PATCH(l.id, { client_ref: stored });
      if (!res.ok) throw new Error("No se pudo completar la acción");
      setClientRef(stored ?? "");
      onRepaint(l.id, { client_ref: stored });
      // The rollup regroups by client_ref; nothing else depends on it, so
      // the Overview refetches that card alone.
      announceOverviewChange("client-ref");
    } catch (err) {
      alert("Error: " + errorText(err));
    }
  }

  /**
   * Any link's destination, not only card stock: the short code is what is
   * printed, so it can change without reprinting. An emptied field turns the
   * link back into card stock. Not validated here: the server owns the URL
   * rules, and a second copy of them in the browser is how the two drift.
   * The row shows the destination as the server stored it (normalized); on
   * a refusal nothing changes, so the typed value stays to be corrected.
   */
  async function saveDestination() {
    const value = destination.trim();
    try {
      const res = await PATCH(l.id, { original_url: value === "" ? null : value });
      const body = (await res.json().catch(() => ({}))) as { error?: string; original_url?: string | null };
      if (!res.ok) throw new Error(body.error || "No se pudo completar la acción");
      const stored = body.original_url ?? null;
      setDestination(stored ?? "");
      onRepaint(l.id, { original_url: stored });
    } catch (err) {
      alert("Error: " + errorText(err));
    }
  }

  /** Assigns the link to a branch, or to none. On failure the picker goes back to the stored branch. */
  async function saveBranch() {
    const value = shownBranch;
    try {
      const res = await PATCH(l.id, { location_id: value === "" ? null : value });
      if (!res.ok) throw new Error("No se pudo completar la acción");
      const picked = branches.all.find((b) => b.id === value);
      onRepaint(l.id, {
        location_id: value === "" ? null : value,
        location_name: picked ? picked.name : null,
        business_name: picked ? (picked.business_name ?? null) : null,
      });
    } catch (err) {
      setBranch(l.location_id ?? "");
      alert("Error: " + errorText(err));
    }
  }

  async function remove() {
    if (!confirm("¿Eliminar este enlace de forma permanente?")) return;
    try {
      const res = await api("DELETE", `/api/links/${encodeURIComponent(l.id)}`);
      if (!res.ok) throw new Error("No se pudo completar la acción");
      onReload();
    } catch (err) {
      alert("Error: " + errorText(err));
    }
  }

  const status = linkStatus(l);
  // A card with a destination is done: nothing to print. One already printed
  // says Reprint, so sending it to the queue again is a deliberate choice and
  // not a first print by mistake.
  const printButton = l.original_url ? null : (
    <button className="btn-sm btn-outline" onClick={() => setPrintQueued(l.id, !queued, l.short_code)}>
      {queued ? "Quitar de la cola" : l.printed_at ? "Reimprimir" : "Enviar a imprimir"}
    </button>
  );

  return (
    <>
      <tr>
        <td>
          <span className="code" title={`Haz clic para copiar ${shortUrl}`} onClick={() => void copy()}>
            {copied ? "¡Copiado!" : l.short_code}
          </span>
        </td>
        <td className="hide-sm">
          {l.location_name ? (
            <>
              <span className="owner-business">{l.business_name || "Sin local"}</span>
              <span className="owner-branch">{l.location_name}</span>
            </>
          ) : (
            <span className="owner-none">Sin asignar</span>
          )}
        </td>
        <td className="hide-sm">
          {l.original_url ? (
            <span className="url-trunc" title={l.original_url}>
              {l.original_url}
            </span>
          ) : (
            printButton
          )}
        </td>
        <td className="hide-sm">
          {l.is_gated ? <span className="badge badge-gated">Pantalla de reseña</span> : <span className="badge badge-direct">Directo</span>}
        </td>
        <td>
          <a
            href="#"
            className="clicks-link"
            onClick={(e) => {
              e.preventDefault();
              onTogglePanel(l.id);
            }}
          >
            {l.clicks_count}
          </a>
        </td>
        <td>
          <span className={`badge badge-${status}`}>{STATUS_LABEL[status]}</span>
          {l.original_url ? null : (
            <>
              {" "}
              {/* One badge, two states: waiting wins over a past run, because
                  the pending action is what the owner has to do next. */}
              <span
                className={`badge ${!queued && l.printed_at ? "badge-printed" : "badge-queued"}`}
                data-print-badge={l.id}
                hidden={!queued && !l.printed_at}
                title={!queued && l.printed_at ? printedTitle(l.printed_at) : undefined}
              >
                {!queued && l.printed_at ? "Impresa" : "Por imprimir"}
              </span>
            </>
          )}
        </td>
        <td>
          <div className="row-actions">
            <button className="btn-sm btn-outline" onClick={() => onEdit(l.id)}>
              Editar
            </button>
            <button className="btn-sm btn-danger" onClick={() => void remove()}>
              Eliminar
            </button>
          </div>
        </td>
      </tr>
      <tr id={`metrics-${l.id}`} style={{ display: open ? "" : "none" }}>
        <td colSpan={7} className="flush-cell">
          <div className="panel-pad">
            {/* What you do TO a tag lives here, not in the row: an editable
                identifier and four buttons in the last column pushed the
                actions off a phone screen, and this panel, opened by the
                row's primary action, already holds the rest. */}
            <div className="panel-controls">
              <div className="field">
                <label htmlFor={`client-ref-${l.id}`}>Referencia de cliente</label>
                <div className="field-row">
                  <input
                    type="text"
                    id={`client-ref-${l.id}`}
                    value={clientRef}
                    onChange={(e) => setClientRef(e.target.value)}
                    placeholder="Ninguna"
                    maxLength={200}
                    className="client-ref-input"
                  />
                  <button className="btn-sm btn-outline" onClick={() => void saveClientRef()}>
                    Guardar
                  </button>
                </div>
              </div>
              <div className="field">
                <label>Hoja de impresión</label>
                <div className="field-row">
                  <button
                    className="btn-sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      // Raw: the modal encodes exactly once.
                      onShowQR(shortUrl);
                    }}
                  >
                    Código QR
                  </button>
                  {printButton}
                </div>
                <p className="field-note">El código que va en el adhesivo. Este es el destino al que lleva la etiqueta impresa.</p>
              </div>
              <div className="field">
                <label htmlFor={`dest-${l.id}`}>Destino</label>
                <div className="field-row">
                  <input
                    type="text"
                    id={`dest-${l.id}`}
                    value={destination}
                    onChange={(e) => setDestination(e.target.value)}
                    placeholder="Sin configurar"
                    className="client-ref-input"
                  />
                  <button className="btn-sm btn-primary" onClick={() => void saveDestination()}>
                    Guardar
                  </button>
                </div>
                <p className="field-note">
                  {l.original_url
                    ? "Adónde lleva el código impreso. Cambiarlo no requiere reimprimir."
                    : 'Esta tarjeta aún no tiene destino. Quien la escanee verá una página "sin configurar". Guarda la URL cuando esté definida: el adhesivo impreso no necesita reimprimirse.'}
                </p>
              </div>
              <div className="field">
                <label htmlFor={`branch-${l.id}`}>Sucursal</label>
                <div className="field-row">
                  <select
                    id={`branch-${l.id}`}
                    data-current={l.location_id ?? ""}
                    className="client-ref-input"
                    value={shownBranch}
                    onChange={(e) => setBranch(e.target.value)}
                  >
                    {pickerOptions.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                  <button className="btn-sm btn-outline" onClick={() => void saveBranch()}>
                    Guardar
                  </button>
                </div>
                <p className="field-note">El local y la sucursal a los que pertenece este adhesivo. Sus comentarios y calificaciones se agrupan ahí.</p>
              </div>
              <div className="field">
                <label>Pantalla de reseña</label>
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={gated}
                    disabled={gateBusy}
                    onChange={(e) => void saveGated(e.target.checked)}
                  />
                  <span>Mostrar antes de redirigir</span>
                </label>
                <p className="field-note" data-gate-note="on" hidden={!gated}>
                  Los escaneos muestran la calificación con estrellas, el botón de Google y un formulario de comentario privado.
                </p>
                <p className="field-note" data-gate-note="off" hidden={gated}>
                  Los escaneos van directo al destino. No se registra nada para el panel de satisfacción.
                </p>
              </div>
              <div className="field">
                <label>Estado de la etiqueta</label>
                <div className="field-row">
                  <button className="btn-sm btn-outline" onClick={() => void toggleActive()}>
                    {l.is_active ? "Desactivar" : "Activar"}
                  </button>
                </div>
                {/* Why the redirect is a 302 and not a 301, said where the decision is made. */}
                <p className="field-note">
                  {l.is_active
                    ? "Esta etiqueta deja de funcionar. Quien tenga el adhesivo impreso conserva el destino anterior hasta que expire la caché de su navegador."
                    : "Esta etiqueta vuelve a funcionar. El adhesivo impreso funciona desde el próximo escaneo."}
                </p>
              </div>
            </div>
            <div className="metric-box visitors-box">
              <h4>Visitantes (estimación)</h4>
              <div id={`visitors-${l.id}`}>
                <Visitors metrics={metrics} />
              </div>
              {/* The caveat ships beside the numbers, wherever they are shown. */}
              <p className="estimate-note">{VISITOR_ESTIMATE_CAVEAT}</p>
            </div>
            <div className="metrics-grid">
              <div className="metric-box">
                <h4>Por país</h4>
                <div id={`country-${l.id}`}>
                  <Breakdown metrics={metrics} pick={(d) => d.by_country} showsError />
                </div>
              </div>
              <div className="metric-box">
                <h4>Por dispositivo</h4>
                <div id={`device-${l.id}`}>
                  <Breakdown metrics={metrics} pick={(d) => d.by_device} />
                </div>
              </div>
              <div className="metric-box">
                <h4>Por origen</h4>
                <div id={`source-${l.id}`}>
                  <Breakdown metrics={metrics} pick={(d) => d.by_source} />
                </div>
              </div>
            </div>
          </div>
        </td>
      </tr>
    </>
  );
}

const Loading = () => <div className="loading">Cargando…</div>;

/**
 * The two visitor figures, with EQUAL weight on purpose: neither is the
 * "real" one, so they share the same markup. The window labels come from the
 * API, so the text cannot describe a different window than the SQL used, and
 * a missing figure reads 0 rather than "undefined".
 */
function Visitors({ metrics }: { metrics: MetricsState | undefined }) {
  if (metrics?.status !== "ready") return <Loading />;
  const data = metrics.data;
  return (
    <>
      <div className="metric-row">
        <span>Visitantes únicos (período: {spanishWindow(data.unique_window || "1 day")})</span>
        <strong>{data.unique_visitors ?? 0}</strong>
      </div>
      <div className="metric-row">
        <span>Sesiones (cada {spanishWindow(data.session_window || "30 minutes")})</span>
        <strong>{data.sessions ?? 0}</strong>
      </div>
    </>
  );
}

/** One click breakdown, busiest first. The country box is the one that reports a failed fetch. */
function Breakdown({
  metrics,
  pick,
  showsError = false,
}: {
  metrics: MetricsState | undefined;
  pick: (data: ClickMetrics) => Record<string, number> | undefined;
  showsError?: boolean;
}) {
  if (metrics?.status === "error" && showsError) return <div className="metric-row">Error: {metrics.message}</div>;
  if (metrics?.status !== "ready") return <Loading />;
  const entries = Object.entries(pick(metrics.data) ?? {}).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return <div className="metric-row">Sin datos</div>;
  return (
    <>
      {entries.map(([key, value]) => (
        <div className="metric-row" key={key}>
          <span>{key}</span>
          <strong>{value}</strong>
        </div>
      ))}
    </>
  );
}
