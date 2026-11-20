import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { flushSync } from "react-dom";
import { VISITOR_ESTIMATE_CAVEAT } from "../../../src/analytics/metrics";
import { useBranches } from "../branches/store";
import { announceOverviewChange } from "../overview/changes";
import { getPrintQueue, prunePrintQueue, subscribePrintQueue } from "../print-queue";
import type { BranchList } from "./branches";
import { CreateCard } from "./CreateCard";
import { LinkRow, type MetricsState } from "./LinkRow";
import { fetchLinks, type ClickMetrics, type Link } from "./load";
import { QrModal } from "./QrModal";
import { provideLinksLoad } from "./reload";
import { api, whenApiReady } from "../api";

/**
 * THE LINKS SECTION (dashboard-react T3a/T3b, S2/S5).
 *
 * Everything inside the server-rendered `<section data-section="links">`: the
 * create card (single link and bulk card stock), the links table in
 * `#links-card`, and the QR modal its rows open. It keeps the ids and classes
 * the dashboard's CSS was written against (#link-count, #links-loading,
 * #links-table, #links-body, #links-empty, the per-link metrics-/dest-/
 * branch-/client-ref- ids, .qr-modal), so the styles and print rules apply
 * as is. The `<section>` itself stays server-rendered: the legacy
 * showSection toggles its `hidden`.
 *
 * It loads itself once the auth bootstrap opens the API gate (../api). Creating
 * here reloads through the same load directly; the sections that change what
 * the table shows from outside (Cards after a print run, Businesses after a
 * rename, move or switch) reach the same load through ./reload. The branch
 * pickers read the in-bundle branches store (../branches).
 *
 * The Overview's gate and clients cards load themselves (L13). They summarise
 * the links, so every reload after the first one announces "links" to the
 * Overview island (../overview/changes), which refetches them: they stay in
 * step with the table as they did when this load painted them.
 */

type View =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; links: Link[] };

export function LinksSection({ limit }: { limit: number }) {
  const [view, setView] = useState<View>({ status: "loading" });
  const [count, setCount] = useState(0);
  // Bumped by every full load: rows remount, dropping unsaved typing, as the
  // legacy re-render did. A single-link repaint keeps it.
  const [generation, setGeneration] = useState(0);
  const [open, setOpenState] = useState<ReadonlySet<string>>(new Set());
  const [metrics, setMetricsState] = useState<Record<string, MetricsState>>({});
  /** The short URL whose QR is on show, or null while the modal is closed. */
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const queue = useSyncExternalStore(subscribePrintQueue, getPrintQueue);
  const store = useBranches();
  const branches: BranchList = useMemo(
    () => ({ all: store.branches, businesses: store.businesses }),
    [store.branches, store.businesses],
  );

  // Read by callbacks that must stay stable across loads.
  /** The links of a table on screen, or null while loading or after an error. */
  const shown = useRef<Link[] | null>(null);
  const openRef = useRef(open);
  const metricsRef = useRef(metrics);
  const loadSeq = useRef(0);
  /** Whether a load has landed: the first one has nothing to tell the Overview, which loads at boot too. */
  const loadedOnce = useRef(false);
  const inflight = useRef(new Map<string, object>());

  const setOpen = (next: ReadonlySet<string>) => {
    openRef.current = next;
    setOpenState(next);
  };
  const setMetric = (id: string, state: MetricsState | undefined) => {
    const next = { ...metricsRef.current };
    if (state) next[id] = state;
    else delete next[id];
    metricsRef.current = next;
    setMetricsState(next);
  };

  /** GET /api/links/:id/clicks, once per opening that has no figures yet. */
  const fetchMetrics = useCallback(async (id: string) => {
    const token = {};
    inflight.current.set(id, token);
    setMetric(id, { status: "loading" });
    try {
      const res = await api("GET", `/api/links/${encodeURIComponent(id)}/clicks`);
      if (!res) throw new Error("Sin respuesta");
      const data = (await res.json()) as ClickMetrics;
      if (!res.ok) throw new Error(data.error || "Error del servidor");
      if (inflight.current.get(id) === token) setMetric(id, { status: "ready", data });
    } catch (err) {
      if (inflight.current.get(id) === token) {
        setMetric(id, { status: "error", message: err instanceof Error ? err.message : "Error desconocido" });
      }
    } finally {
      if (inflight.current.get(id) === token) inflight.current.delete(id);
    }
  }, []);

  const ensureMetrics = useCallback(
    (id: string) => {
      if (metricsRef.current[id]?.status === "ready" || inflight.current.has(id)) return;
      void fetchMetrics(id);
    },
    [fetchMetrics],
  );

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    // Safe at any point in the page lifecycle: a call made while getSession()
    // is still in flight parks here, and runs once the helper can authenticate.
    await whenApiReady();

    // A table already on screen means a refresh after an edit, not the first
    // load. Hiding it then collapsed the page and threw the owner back to the
    // top after every Save, so a refresh repaints in place and reopens the
    // panels that were open.
    const refreshing = shown.current !== null && shown.current.length > 0;
    const reopen = refreshing ? [...openRef.current] : [];
    if (!refreshing) setView({ status: "loading" });

    try {
      const links = await fetchLinks();
      if (seq !== loadSeq.current) return;

      // The print queue lives in this page; a load only prunes it.
      prunePrintQueue(links);
      shown.current = links;
      setCount(links.length);
      setView({ status: "ready", links });
      if (loadedOnce.current) announceOverviewChange("links");
      loadedOnce.current = true;

      // The re-render drops the figures with the old rows; the panels that
      // stay open fetch theirs again.
      inflight.current.clear();
      metricsRef.current = {};
      setMetricsState({});
      const still = reopen.filter((id) => links.some((l) => l.id === id));
      setOpen(new Set(still));
      setGeneration((g) => g + 1);
      still.forEach((id) => void fetchMetrics(id));
    } catch (err) {
      if (seq !== loadSeq.current) return;
      shown.current = null;
      setView({ status: "error", message: "No se pudieron cargar los enlaces. " + (err instanceof Error ? err.message : "") });
    }
  }, [fetchMetrics]);

  useEffect(() => {
    const unprovide = provideLinksLoad(load);
    void load();
    return () => {
      unprovide();
      // Results that land after unmounting are dropped.
      loadSeq.current++;
    };
  }, [load]);

  /** Applies a saved change to one link, without reloading the table. */
  const repaint = useCallback(
    (id: string, changes: Partial<Link>) => {
      const current = shown.current;
      if (!current || !current.some((l) => l.id === id)) {
        // Nothing on screen to patch: fall back to the full load.
        void load();
        return;
      }
      const next = current.map((l) => (l.id === id ? { ...l, ...changes } : l));
      shown.current = next;
      setView({ status: "ready", links: next });
      // A destination takes the link out of the print queue.
      prunePrintQueue(next);
    },
    [load],
  );

  const togglePanel = useCallback(
    (id: string) => {
      const next = new Set(openRef.current);
      if (next.delete(id)) {
        setOpen(next);
        return;
      }
      next.add(id);
      setOpen(next);
      ensureMetrics(id);
    },
    [ensureMetrics],
  );

  /** Opens the same panel as the clicks count, never closes it, and focuses the destination. */
  const edit = useCallback(
    (id: string) => {
      if (!openRef.current.has(id)) {
        // Rendered before focusing: a hidden input cannot take the cursor.
        flushSync(() => setOpen(new Set(openRef.current).add(id)));
        ensureMetrics(id);
      }
      document.getElementById(`dest-${id}`)?.focus();
    },
    [ensureMetrics],
  );

  const queued = new Set(queue.map((item) => item.id));
  const links = view.status === "ready" ? view.links : [];
  const showTable = links.length > 0;
  const emptyText =
    view.status === "error" ? view.message : view.status === "ready" && links.length === 0 ? "Aún no tienes enlaces. ¡Crea el primero arriba!" : "";

  return (
    <>
      <CreateCard onCreated={() => void load()} />
      {/* The table is not part of the printed report. */}
      <div className="card no-print" id="links-card">
        <h3>
          Tus enlaces (<span id="link-count">{count}</span>/{limit})
        </h3>
        <div id="links-loading" className="loading" style={{ display: view.status === "loading" ? "" : "none" }}>
          Cargando…
        </div>
        <div className="table-wrap">
          <table id="links-table" style={{ display: showTable ? "" : "none" }}>
            <thead>
              <tr>
                <th>Código corto</th>
                <th className="hide-sm">Local / sucursal</th>
                <th className="hide-sm">URL</th>
                <th className="hide-sm">Apertura</th>
                <th>Clics</th>
                <th>Estado</th>
                <th></th>
              </tr>
            </thead>
            <tbody id="links-body">
              {links.map((l) => (
                <LinkRow
                  key={`${generation}:${l.id}`}
                  link={l}
                  queued={queued.has(l.id)}
                  open={open.has(l.id)}
                  metrics={metrics[l.id]}
                  branches={branches}
                  onTogglePanel={togglePanel}
                  onEdit={edit}
                  onRepaint={repaint}
                  onReload={() => void load()}
                  onShowQR={setQrUrl}
                />
              ))}
            </tbody>
          </table>
        </div>
        <div id="links-empty" className="empty" style={{ display: emptyText ? "" : "none" }}>
          {emptyText}
        </div>
        {/* Beside the table, not behind a tooltip: a store owner acts on the
            visitor number, so the limitation is on the page before they expand
            anything. The text lives with the metric in src/analytics/metrics.ts. */}
        <p className="estimate-note">
          <strong>Sobre las cifras de visitantes:</strong> {VISITOR_ESTIMATE_CAVEAT}
        </p>
      </div>
      <QrModal url={qrUrl} onClose={() => setQrUrl(null)} />
    </>
  );
}
