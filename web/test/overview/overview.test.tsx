import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VISITOR_ESTIMATE_CAVEAT } from "../../../src/analytics/metrics";
import { MIN_RATED_SAMPLE } from "../../../src/analytics/review-gate";
import { announceOverviewChange } from "../../src/overview/changes";
import { ClientRows, OverviewSection } from "../../src/overview/OverviewSection";
import { count, gate, installApi, settle, type Call, type Handler } from "../links/harness";
import { stubApi, stubApiReady } from "../api-stub";

// The Overview section (dashboard-react T4, S5, L13). Ported from the Worker
// tests of the legacy cards (renderClients, the hourly traffic card, the
// printable report, window.__renderOverviewCards and refreshClientsCard).
// Each card now loads itself, after the auth gate, and degrades on its own.

const XSS_ATTR = '"><img src=x onerror=alert(1)>';

const GATE = {
  split: {
    google: { scans: 20, rated: 12, avgRating: 4.6 },
    private: { scans: 6, rated: 6, avgRating: 2.4 },
    totalScans: 26,
    derivationRate: 20 / 26,
    sentimentGap: 2.2,
  },
  locations: [],
  peaks: [],
  meta: { minRatedSample: MIN_RATED_SAMPLE, peakWindow: "7 days" },
};

const CLIENTS = [{ client_ref: "ACME-0042", unique_visitors: 30, sessions: 42 }];

const TRAFFIC = {
  time_zone: "America/Santiago",
  window: "30 days",
  hours: Array.from({ length: 24 }, (_, hour) => ({ hour, scans: hour === 13 ? 40 : 0 })),
};

type Routes = { gate?: () => unknown; clients?: () => unknown; traffic?: () => unknown };

/** The three Overview endpoints; any other request is a bug. */
function overviewApi(routes: Routes = {}): Call[] {
  const handler: Handler = (method, path) => {
    if (method === "GET" && path === "/api/review-gate/metrics") return routes.gate ? routes.gate() : GATE;
    if (method === "GET" && path === "/api/clients/metrics") return routes.clients ? routes.clients() : CLIENTS;
    if (method === "GET" && path === "/api/traffic/hourly") return routes.traffic ? routes.traffic() : TRAFFIC;
    throw new Error(`unexpected ${method} ${path}`);
  };
  return installApi(handler);
}

const card = (id: string) => document.getElementById(id) as HTMLElement;
const shown = (id: string) => card(id).style.display !== "none";

async function mountOverview() {
  const view = render(<OverviewSection />);
  await settle();
  return view;
}

let errors: { mock: { calls: unknown[][] }; mockRestore: () => void };

beforeEach(() => {
  stubApiReady(Promise.resolve());
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  errors.mockRestore();
  vi.unstubAllGlobals();
});

describe("Overview island — loading", () => {
  it("sends no request until the auth gate opens, then loads its three cards once each", async () => {
    const auth = gate();
    stubApiReady(auth.wait);
    const calls = overviewApi();

    render(<OverviewSection />);
    await settle();
    expect(calls).toEqual([]);
    expect(shown("gate-card")).toBe(false);
    expect(shown("traffic-card")).toBe(false);
    expect(shown("clients-card")).toBe(false);

    auth.release();
    await settle();
    expect(calls.map((c) => `${c.method} ${c.path}`).sort()).toEqual([
      "GET /api/clients/metrics",
      "GET /api/review-gate/metrics",
      "GET /api/traffic/hourly",
    ]);
  });

  it("uses the API answering when the gate opens, not the one at mount", async () => {
    const auth = gate();
    stubApiReady(auth.wait);
    stubApi(undefined);

    render(<OverviewSection />);
    await settle();
    const calls = overviewApi();
    auth.release();
    await settle();

    expect(calls).toHaveLength(3);
    expect(shown("gate-card")).toBe(true);
  });

  it("paints every card in the order the report reads: gate, busy hours, clients", async () => {
    overviewApi();
    const { container } = await mountOverview();

    const ids = [...container.querySelectorAll(".card")].map((c) => c.id);
    expect(ids).toEqual(["gate-card", "traffic-card", "clients-card"]);
    expect(card("gate-card").querySelector("h3")!.textContent).toBe("Satisfacción de clientes");
    expect(card("traffic-card").querySelector("h3")!.textContent).toBe("Horas concurridas");
    expect(card("clients-card").querySelector("h3")!.textContent).toBe("Locales por referencia de cliente");
    expect(card("gate-body").textContent).toContain("76.9%");
    expect(card("traffic-body").querySelector(".hour-summary")!.textContent).toBe("Hora más concurrida: 13:00–14:00 (40 escaneos)");
    expect(shown("gate-card") && shown("traffic-card") && shown("clients-card")).toBe(true);
  });
});

describe("Overview island — each card degrades on its own", () => {
  it("hides the gate card when its request fails, and keeps the others", async () => {
    overviewApi({
      gate: () => {
        throw new Error("gate down");
      },
    });
    await mountOverview();

    expect(shown("gate-card")).toBe(false);
    expect(shown("traffic-card")).toBe(true);
    expect(shown("clients-card")).toBe(true);
    expect(errors).toHaveBeenCalledWith("gate panel failed to load", expect.any(Error));
  });

  it("hides the gate card when the panel cannot render its payload, and keeps the others", async () => {
    overviewApi({ gate: () => ({ rated: 0 }) });
    await mountOverview();

    expect(shown("gate-card")).toBe(false);
    expect(card("gate-body").textContent).toBe("");
    expect(shown("traffic-card")).toBe(true);
    expect(shown("clients-card")).toBe(true);
    expect(errors.mock.calls.some((c: unknown[]) => c[0] === "gate panel failed to render")).toBe(true);
  });

  it("hides the busy-hours card when its request fails, and keeps the others", async () => {
    overviewApi({
      traffic: () => {
        throw new Error("traffic down");
      },
    });
    await mountOverview();

    expect(shown("traffic-card")).toBe(false);
    expect(shown("gate-card")).toBe(true);
    expect(shown("clients-card")).toBe(true);
    expect(errors).toHaveBeenCalledWith("hourly traffic failed to load", expect.any(Error));
  });

  it("shows the busy-hours card with its empty note when nothing was scanned", async () => {
    overviewApi({ traffic: () => ({ ...TRAFFIC, hours: [] }) });
    await mountOverview();

    expect(shown("traffic-card")).toBe(true);
    expect(card("traffic-body").textContent).toBe("Aún no hay escaneos en los últimos 30 días.");
  });

  it("hides the clients card when the rollup cannot be read, and keeps the others", async () => {
    overviewApi({
      clients: () => {
        throw new Error("rollup down");
      },
    });
    await mountOverview();

    expect(shown("clients-card")).toBe(false);
    expect(shown("gate-card")).toBe(true);
    expect(shown("traffic-card")).toBe(true);
    expect(errors).toHaveBeenCalledWith("client rollup failed to load", expect.any(Error));
  });

  it("hides the clients card when no store has a client_ref", async () => {
    overviewApi({ clients: () => [] });
    await mountOverview();
    expect(shown("clients-card")).toBe(false);
  });

  it("reads a rollup that is not a list as empty, and hides the card", async () => {
    overviewApi({ clients: () => ({ nope: true }) });
    await mountOverview();
    expect(shown("clients-card")).toBe(false);
  });
});

describe("Overview island — the client rollup", () => {
  it("renders one row per client with both figures", async () => {
    overviewApi({ clients: () => [...CLIENTS, { client_ref: "B-2", unique_visitors: 1, sessions: 2 }] });
    await mountOverview();

    const rows = [...card("clients-body").querySelectorAll("tr")].map((tr) =>
      [...tr.querySelectorAll("td")].map((td) => td.textContent),
    );
    expect(rows).toEqual([
      ["ACME-0042", "30", "42"],
      ["B-2", "1", "2"],
    ]);
    expect(card("clients-body").querySelector("td .code")!.textContent).toBe("ACME-0042");
    expect([...card("clients-card").querySelectorAll("thead th")].map((th) => th.textContent)).toEqual([
      "Referencia de cliente",
      "Visitantes únicos",
      "Sesiones",
    ]);
  });

  it("renders client_ref, which is user-supplied free text, as text", async () => {
    overviewApi({ clients: () => [{ client_ref: XSS_ATTR, unique_visitors: 1, sessions: 1 }] });
    await mountOverview();

    expect(card("clients-body").querySelector("img")).toBeNull();
    expect(card("clients-body").querySelector(".code")!.textContent).toBe(XSS_ATTR);
  });

  it("shows the visitor caveat next to the store-level rollup", async () => {
    overviewApi();
    await mountOverview();
    expect(card("clients-card").querySelector(".estimate-note")!.textContent).toBe(VISITOR_ESTIMATE_CAVEAT);
  });

  it("explains the empty state instead of rendering a bare table", () => {
    const { container } = render(
      <table>
        <tbody>
          <ClientRows clients={[]} />
        </tbody>
      </table>,
    );
    const cell = container.querySelector("td.empty-cell")!;
    expect(cell.getAttribute("colspan")).toBe("3");
    expect(cell.textContent).toBe("Aún no hay referencias de cliente: asigna una a un enlace para ver los visitantes por local.");
  });
});

describe("Overview island — stays in step with the Links section", () => {
  it("refetches the gate panel and the rollup after a Links load, not the busy hours", async () => {
    let rated = 12;
    let clients = CLIENTS;
    const calls = overviewApi({
      gate: () => ({ ...GATE, split: { ...GATE.split, google: { ...GATE.split.google, rated } } }),
      clients: () => clients,
    });
    await mountOverview();

    rated = 13;
    clients = [{ client_ref: "NEW-1", unique_visitors: 2, sessions: 3 }];
    act(() => announceOverviewChange("links"));
    await settle();

    expect(count(calls, "GET", "/api/review-gate/metrics")).toBe(2);
    expect(count(calls, "GET", "/api/clients/metrics")).toBe(2);
    expect(count(calls, "GET", "/api/traffic/hourly")).toBe(1);
    expect(card("gate-body").textContent).toContain("según 13 de 20");
    expect(card("clients-body").textContent).toContain("NEW-1");
  });

  it("refetches only the rollup after a client_ref save", async () => {
    const calls = overviewApi();
    await mountOverview();

    act(() => announceOverviewChange("client-ref"));
    await settle();

    expect(count(calls, "GET", "/api/clients/metrics")).toBe(2);
    expect(count(calls, "GET", "/api/review-gate/metrics")).toBe(1);
    expect(count(calls, "GET", "/api/traffic/hourly")).toBe(1);
  });

  it("hides the clients card when a refresh finds the rollup empty", async () => {
    let clients: unknown = CLIENTS;
    overviewApi({ clients: () => clients });
    await mountOverview();
    expect(shown("clients-card")).toBe(true);

    clients = [];
    act(() => announceOverviewChange("client-ref"));
    await settle();
    expect(shown("clients-card")).toBe(false);
  });

  it("keeps the cards it already shows when a refresh fails", async () => {
    let fail = false;
    overviewApi({
      gate: () => {
        if (fail) throw new Error("gate down");
        return GATE;
      },
      clients: () => {
        if (fail) throw new Error("rollup down");
        return CLIENTS;
      },
    });
    await mountOverview();

    fail = true;
    act(() => announceOverviewChange("links"));
    await settle();

    expect(shown("gate-card")).toBe(true);
    expect(card("gate-body").textContent).toContain("76.9%");
    expect(shown("clients-card")).toBe(true);
    expect(card("clients-body").textContent).toContain("ACME-0042");
  });

  it("paints only the newest rollup when an older one answers last", async () => {
    const slow = gate();
    let call = 0;
    overviewApi({
      clients: () => {
        call++;
        if (call === 2) return slow.wait.then(() => [{ client_ref: "stale", unique_visitors: 1, sessions: 1 }]);
        return [{ client_ref: call === 1 ? "first" : "fresh", unique_visitors: 1, sessions: 1 }];
      },
    });
    await mountOverview();

    act(() => announceOverviewChange("client-ref"));
    await settle();
    act(() => announceOverviewChange("client-ref"));
    await settle();
    slow.release();
    await settle();

    expect(card("clients-body").textContent).toContain("fresh");
    expect(card("clients-body").textContent).not.toContain("stale");
  });

  it("stops listening when the island goes away", async () => {
    const calls = overviewApi();
    const view = await mountOverview();
    view.unmount();

    act(() => announceOverviewChange("links"));
    await settle();
    expect(calls).toHaveLength(3);
  });
});

describe("Overview island — the printable report", () => {
  it("offers a print button outside the report, which prints the page", async () => {
    const print = vi.fn();
    vi.stubGlobal("print", print);
    overviewApi();
    await mountOverview();

    const button = card("print-report") as HTMLButtonElement;
    expect(button.type).toBe("button");
    expect(button.className).toBe("btn-sm btn-outline");
    expect(button.textContent).toBe("Imprimir informe");
    expect(button.querySelector("svg.icon")!.getAttribute("aria-hidden")).toBe("true");
    // The control is not part of what gets printed.
    expect(button.closest(".report-actions.no-print")).not.toBeNull();

    fireEvent.click(button);
    expect(print).toHaveBeenCalledTimes(1);
  });

  it("keeps the report cards themselves printable", async () => {
    overviewApi();
    const { container } = await mountOverview();
    expect(container.querySelectorAll(".card.no-print")).toHaveLength(0);
  });
});
