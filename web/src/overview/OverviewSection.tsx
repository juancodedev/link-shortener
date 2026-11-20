import { Component, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { VISITOR_ESTIMATE_CAVEAT } from "../../../src/analytics/metrics";
import { onOverviewChange } from "./changes";
import { GatePanel, type GatePanelPayload } from "./GatePanel";
import { HourlyTraffic, type HourlyPayload } from "./HourlyTraffic";
import { api, whenApiReady } from "../api";

/**
 * THE OVERVIEW SECTION (dashboard-react T4, S5).
 *
 * Everything inside the server-rendered `<section data-section="overview">`:
 * the print button and the three report cards (satisfaction, busy hours,
 * stores by client_ref). It keeps the ids and classes the dashboard's CSS and
 * print rules were written against (#print-report, #gate-card/#gate-body,
 * #traffic-card/#traffic-body, #clients-card/#clients-body). The `<section>`
 * itself stays server-rendered: the legacy showSection toggles its `hidden`
 * and the print stylesheet keys the report on it.
 *
 * Split loading (L13): each card fetches its own data once the auth bootstrap
 * opens the API gate (../api), and degrades on its own. A card that cannot load
 * stays hidden on the first load and keeps what it shows on a later one; no
 * card's failure touches another, or the Links table.
 *
 * Freshness: the gate panel and the rollup summarise the links, so they
 * refetch whenever the Links island announces a reload, and the rollup again
 * after a client_ref save (./changes). Busy hours load once, at boot, as
 * before: no table edit moves them.
 */

/** One row of GET /api/clients/metrics. */
export type ClientRollup = { client_ref?: string | null; unique_visitors?: number; sessions?: number };

/**
 * The per-store rollup's rows. `client_ref` is the identifier the owner types
 * per store, so it is user data: JSX text, never markup.
 */
export function ClientRows({ clients }: { clients: ClientRollup[] }) {
  if (clients.length === 0) {
    return (
      <tr>
        <td colSpan={3} className="empty-cell">
          No client identifiers yet — set one on a link to see store-level visitors.
        </td>
      </tr>
    );
  }
  return (
    <>
      {clients.map((c, i) => (
        <tr key={`${c.client_ref ?? ""}:${i}`}>
          <td>
            <span className="code">{c.client_ref}</span>
          </td>
          <td>{c.unique_visitors}</td>
          <td>{c.sessions}</td>
        </tr>
      ))}
    </>
  );
}

/** The dashboard's print icon (src/handlers/icons.ts `print`, Lucide), drawn as JSX. */
function PrintIcon() {
  return (
    <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
      <path d="M6 9V3a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v6" />
      <rect x="6" y="14" width="12" height="8" rx="1" />
    </svg>
  );
}

const hidden = { display: "none" } as const;

function HiddenGateCard() {
  return (
    <div className="card" id="gate-card" style={hidden}>
      <h3>Customer satisfaction</h3>
      <div id="gate-body"></div>
    </div>
  );
}

/**
 * A payload the panel cannot render (a changed API shape, a partial row)
 * hides the satisfaction card instead of breaking the whole Overview. Keyed
 * by load, so the next payload gets a fresh try.
 */
class GateBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(err: unknown) {
    console.error("gate panel failed to render", err);
  }

  render() {
    return this.state.failed ? <HiddenGateCard /> : this.props.children;
  }
}

/** GETs one Overview endpoint once the auth gate is open; throws on any failure. */
async function fetchJson(path: string): Promise<unknown> {
  // Safe at any point in the page lifecycle: a call made while getSession()
  // is still in flight parks here, and runs once the helper can authenticate.
  await whenApiReady();
  const res = await api("GET", path);
  if (!res || !res.ok) throw new Error(`${path}: HTTP ${res ? res.status : "no response"}`);
  return res.json();
}

export function OverviewSection() {
  /** The panel's payload, numbered per load so a new one resets the boundary; null while hidden. */
  const [gate, setGate] = useState<{ payload: GatePanelPayload; load: number } | null>(null);
  const [traffic, setTraffic] = useState<HourlyPayload | null>(null);
  /** An empty rollup hides its card: no store has recorded traffic yet. */
  const [clients, setClients] = useState<ClientRollup[]>([]);
  // Per card: only the newest request may paint, and none after unmounting.
  const seq = useRef({ gate: 0, clients: 0, traffic: 0 });

  const loadGate = useCallback(async () => {
    const n = ++seq.current.gate;
    try {
      const payload = (await fetchJson("/api/review-gate/metrics")) as GatePanelPayload;
      if (n === seq.current.gate) setGate({ payload, load: n });
    } catch (err) {
      // A tenant who never activated a gated link may have no panel to show;
      // that is not worth failing anything else over.
      if (n === seq.current.gate) console.error("gate panel failed to load", err);
    }
  }, []);

  const loadClients = useCallback(async () => {
    const n = ++seq.current.clients;
    try {
      const payload = await fetchJson("/api/clients/metrics");
      // Anything but a list degrades to an empty rollup, which hides the card.
      if (n === seq.current.clients) setClients(Array.isArray(payload) ? (payload as ClientRollup[]) : []);
    } catch (err) {
      if (n === seq.current.clients) console.error("client rollup failed to load", err);
    }
  }, []);

  const loadTraffic = useCallback(async () => {
    const n = ++seq.current.traffic;
    try {
      const payload = (await fetchJson("/api/traffic/hourly")) as HourlyPayload;
      if (n === seq.current.traffic) setTraffic(payload ?? {});
    } catch (err) {
      // A report, not the workflow: the card hides rather than failing.
      if (n === seq.current.traffic) {
        setTraffic(null);
        console.error("hourly traffic failed to load", err);
      }
    }
  }, []);

  useEffect(() => {
    const counters = seq.current;
    void loadGate();
    void loadTraffic();
    void loadClients();
    const stop = onOverviewChange((change) => {
      if (change === "links") void loadGate();
      void loadClients();
    });
    return () => {
      stop();
      // Results that land after unmounting are dropped.
      counters.gate++;
      counters.clients++;
      counters.traffic++;
    };
  }, [loadGate, loadClients, loadTraffic]);

  return (
    <>
      {/* The report is what the owner forwards: the print stylesheet keeps
          the metric cards and drops everything that is a control. */}
      <div className="report-actions no-print">
        <button type="button" id="print-report" className="btn-sm btn-outline" onClick={() => window.print()}>
          <PrintIcon />
          <span>Print report</span>
        </button>
      </div>

      {/* Presentable as a screenshot on purpose: every figure carries its own
          qualification in the markup rather than in a tooltip. */}
      {gate ? (
        <GateBoundary key={gate.load}>
          <div className="card" id="gate-card">
            <h3>Customer satisfaction</h3>
            <div id="gate-body">
              <GatePanel payload={gate.payload} />
            </div>
          </div>
        </GateBoundary>
      ) : (
        <HiddenGateCard />
      )}

      {/* Same screenshot discipline: the window and the time zone are printed
          under the chart, not in a tooltip. */}
      <div className="card" id="traffic-card" style={traffic ? undefined : hidden}>
        <h3>Busy hours</h3>
        <div id="traffic-body">{traffic && <HourlyTraffic payload={traffic} />}</div>
      </div>

      <div className="card" id="clients-card" style={clients.length > 0 ? undefined : hidden}>
        <h3>Stores by Client Ref</h3>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Client Ref</th>
                <th>Unique Visitors</th>
                <th>Sessions</th>
              </tr>
            </thead>
            <tbody id="clients-body">{clients.length > 0 && <ClientRows clients={clients} />}</tbody>
          </table>
        </div>
        {/* The visitor caveat, next to the store-level rollup. */}
        <p className="estimate-note">{VISITOR_ESTIMATE_CAVEAT}</p>
      </div>
    </>
  );
}
