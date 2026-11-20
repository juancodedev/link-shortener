import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MIN_RATED_SAMPLE } from "../../../src/analytics/review-gate";
import { GatePanel, type GatePanelPayload } from "../../src/overview/GatePanel";

// The satisfaction panel (dashboard-react T4), ported from
// test/handlers/gate-panel.test.ts and the gate-panel describe of
// test/handlers/dashboard-tokens.test.ts, which exercised the string renderer
// the legacy page injected with toString().
//
// This screen is what the owner screenshots and forwards as their monthly
// report, so the tests here are mostly about one thing: nothing may be
// readable on this panel without its qualification next to it.

const META = { minRatedSample: MIN_RATED_SAMPLE, peakWindow: "7 days" };

function payload(over: Partial<GatePanelPayload> = {}): GatePanelPayload {
  return {
    split: {
      google: { scans: 20, rated: 12, avgRating: 4.6 },
      private: { scans: 6, rated: 6, avgRating: 2.4 },
      totalScans: 26,
      derivationRate: 20 / 26,
      sentimentGap: 2.2,
    },
    locations: [],
    peaks: [],
    meta: META,
    ...over,
  };
}

const EMPTY_SPLIT = {
  google: { scans: 0, rated: 0, avgRating: null },
  private: { scans: 0, rated: 0, avgRating: null },
  totalScans: 0,
  derivationRate: 0,
  sentimentGap: null,
};

/** Renders the panel and returns its markup and its text, as the owner reads it. */
function panel(p: GatePanelPayload) {
  const { container } = render(<GatePanel payload={p} />);
  return { container, html: container.innerHTML, text: container.textContent ?? "" };
}

afterEach(cleanup);

describe("headline figures", () => {
  it("shows the scan count and both branches", () => {
    const { text } = panel(payload());
    expect(text).toContain("26");
    expect(text).toContain("20 a reseña");
    expect(text).toContain("6 privados");
  });

  it("shows the derivation rate as a percentage", () => {
    // 20/26 = 76.9%, not 0.77. An owner reads this panel, not JSON.
    expect(panel(payload()).text).toContain("76.9%");
  });

  it("renders zero as 0% rather than an empty cell", () => {
    expect(panel(payload({ split: EMPTY_SPLIT })).text).toContain("0%");
  });

  it("lays the five tiles out in order, each with its label", () => {
    const { container } = panel(payload());
    const labels = [...container.querySelectorAll(".stat-tiles > .stat-tile > .label")].map((l) => l.textContent);
    expect(labels).toEqual(["Escaneos", "A reseña", "Calificación · a reseña", "Calificación · privada", "Brecha de sentimiento"]);
  });
});

describe("every average ships with its sample size", () => {
  it("shows n beside the mean for both branches", () => {
    const { text, container } = panel(payload());
    expect(text).toContain("según 12 de 20");
    expect(text).toContain("según 6 de 6");
    expect(container.querySelectorAll(".rating-of")[0]!.textContent).toBe(" / 5");
    expect(text).toContain("4.60 / 5");
  });

  it("withholds the mean and says why when a branch is under the floor", () => {
    const { text, container } = panel(
      payload({
        split: {
          google: { scans: 20, rated: 2, avgRating: null },
          private: { scans: 6, rated: 6, avgRating: 2.4 },
          totalScans: 26,
          derivationRate: 20 / 26,
          sentimentGap: null,
        },
      }),
    );

    // The number must not be readable anywhere on the panel.
    expect(text).not.toContain("4.60");
    expect(text).toContain("Calificaciones insuficientes");
    expect(container.querySelector(".value.withheld")).not.toBeNull();
    // ...and the reader learns how far short it fell.
    expect(text).toContain(`2 de 20 escaneos · se necesitan ${MIN_RATED_SAMPLE}`);
  });

  it("never renders a bare dash that could read as a bug", () => {
    const { html } = panel(
      payload({
        split: {
          google: { scans: 20, rated: 1, avgRating: null },
          private: { scans: 6, rated: 6, avgRating: 2.4 },
          totalScans: 26,
          derivationRate: 20 / 26,
          sentimentGap: null,
        },
      }),
    );
    expect(html).not.toMatch(/>\s*—\s*</);
    expect(html).not.toMatch(/>\s*N\/A\s*</);
  });
});

describe("the sentiment gap", () => {
  it("shows a signed gap when both branches cleared the floor", () => {
    const { text } = panel(payload());
    expect(text).toContain("+2.20");
    expect(text).toContain("pública menos privada");
  });

  it("withholds it when either branch is short, and names the requirement", () => {
    const { text } = panel(
      payload({
        split: {
          google: { scans: 20, rated: 20, avgRating: 4.8 },
          private: { scans: 6, rated: 1, avgRating: null },
          totalScans: 26,
          derivationRate: 20 / 26,
          sentimentGap: null,
        },
      }),
    );
    expect(text).not.toContain("+4.80");
    expect(text).toContain(`se necesitan ${MIN_RATED_SAMPLE} calificaciones en ambos grupos`);
  });

  it("signs a negative gap rather than showing a bare number", () => {
    const { text } = panel(
      payload({
        split: {
          google: { scans: 20, rated: 12, avgRating: 3.1 },
          private: { scans: 6, rated: 6, avgRating: 4.4 },
          totalScans: 26,
          derivationRate: 20 / 26,
          sentimentGap: -1.3,
        },
      }),
    );
    expect(text).toContain("-1.30");
    expect(text).not.toContain("+-1.30");
  });
});

describe("per-location table", () => {
  const location = (over: Partial<GatePanelPayload["locations"][number]> = {}) => ({
    locationId: "loc-1",
    locationName: "Cafe Central",
    googleScans: 3,
    googleRated: 0,
    privateScans: 1,
    privateRated: 0,
    totalScans: 4,
    derivationRate: 0.75,
    ...over,
  });

  it("lists one row per location with its scans and share to review", () => {
    const { container } = panel(payload({ locations: [location()] }));
    expect(container.querySelector("h4.gate-h:nth-of-type(2)")!.textContent).toBe("Por sucursal");
    const head = [...container.querySelectorAll("thead th")].map((th) => th.textContent);
    expect(head).toEqual(["Sucursal", "Escaneos", "A reseña"]);
    const cells = [...container.querySelectorAll("tbody td")].map((td) => td.textContent);
    expect(cells).toEqual(["Cafe Central", "4", "75.0%"]);
  });

  it("labels an unassigned scan rather than showing an empty cell", () => {
    const { text } = panel(payload({ locations: [location({ locationId: null, locationName: null })] }));
    expect(text).toContain("Sin sucursal asignada");
  });

  it("renders a location name from the database as text, never as markup", () => {
    // The name is owner-supplied. A location called `<img onerror=...>` must
    // not become markup on the screen the owner screenshots.
    const { container, html } = panel(payload({ locations: [location({ locationName: "<script>alert(1)</script>" })] }));
    expect(container.querySelector("script")).toBeNull();
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
    expect(container.querySelector("tbody td")!.textContent).toBe("<script>alert(1)</script>");
  });

  it("renders no table at all when there are no locations", () => {
    expect(panel(payload()).container.querySelector("tbody")).toBeNull();
  });
});

describe("peak chart", () => {
  const HOUR = 3600;
  const bars = (c: HTMLElement) =>
    [...c.querySelectorAll<HTMLElement>(".peak-chart > .peak-bar")].map((b) => Number(b.style.height.replace("%", "")));
  const axis = (c: HTMLElement) => [...c.querySelectorAll(".peak-axis span")].map((s) => s.textContent);

  it("draws one slot per hour of the 7-day window, empty hours included", () => {
    // The query only returns hours that had scans. Stretching those across the
    // full width turned one busy hour into a single bar filling the chart.
    const { container } = panel(
      payload({
        peaks: [
          { bucketStart: 1767225600, google: 3, private: 1, total: 4, derivationRate: 0.75 },
          { bucketStart: 1767229200, google: 1, private: 3, total: 4, derivationRate: 0.25 },
        ],
      }),
    );
    const heights = bars(container);
    expect(heights).toHaveLength(168);
    expect(heights.filter((h) => h > 0)).toEqual([100, 100]);
    expect(heights.slice(-2)).toEqual([100, 100]);
  });

  it("does not collapse a single busy hour into a full-width bar with one date on both ends", () => {
    const { container } = panel(
      payload({ peaks: [{ bucketStart: 1767225600, google: 9, private: 9, total: 18, derivationRate: 0.5 }] }),
    );
    const heights = bars(container);
    expect(heights).toHaveLength(168);
    expect(heights.filter((h) => h > 0)).toEqual([100]);
    const [start, end] = axis(container);
    expect(start).not.toBe(end);
    expect(start).toBe(new Date((1767225600 - 167 * HOUR) * 1000).toLocaleString("es-CL"));
    expect(end).toBe(new Date(1767225600 * 1000).toLocaleString("es-CL"));
  });

  it("keeps every bucket when the data spans more than 168 hours", () => {
    const first = 1767225600;
    const last = first + 200 * HOUR;
    const { container } = panel(
      payload({
        peaks: [
          { bucketStart: first, google: 1, private: 0, total: 1, derivationRate: 1 },
          { bucketStart: last, google: 1, private: 0, total: 1, derivationRate: 1 },
        ],
      }),
    );
    const heights = bars(container);
    expect(heights).toHaveLength(201);
    expect(heights[0]).toBe(100);
    expect(heights[200]).toBe(100);
  });

  it("splits each bar into the share that went to review and the rest, with its figures in the title", () => {
    const { container } = panel(
      payload({ peaks: [{ bucketStart: 1767225600, google: 3, private: 1, total: 4, derivationRate: 0.75 }] }),
    );
    const bar = [...container.querySelectorAll<HTMLElement>(".peak-bar")].at(-1)!;
    expect(bar.title).toBe("4 escaneos · 75.0% a reseña");
    expect(bar.querySelector<HTMLElement>(".peak-seg")!.style.height).toBe("100%");
    expect(bar.querySelector<HTMLElement>(".peak-seg-public")!.style.height).toBe("75%");
    expect(bar.querySelector<HTMLElement>(".peak-seg-rest")!.style.height).toBe("25%");
  });

  it("says so when there is no traffic, instead of drawing an empty chart", () => {
    const { container, text } = panel(payload());
    expect(text).toContain("Aún no hay escaneos con etiqueta en los últimos 7 días.");
    expect(container.querySelector(".gate-empty-note")).not.toBeNull();
    expect(container.querySelector(".peak-chart")).toBeNull();
  });

  it("scales bars against the busiest bucket", () => {
    // A chart where the tallest bar is always full regardless of volume is
    // decoration, not information. 4 scans against a max of 4 fills the bar;
    // 1 against 4 is a quarter.
    const { container } = panel(
      payload({
        peaks: [
          { bucketStart: 3600, google: 1, private: 0, total: 1, derivationRate: 1 },
          { bucketStart: 7200, google: 4, private: 0, total: 4, derivationRate: 1 },
        ],
      }),
    );
    expect(bars(container).slice(-2)).toEqual([25, 100]);
  });
});

describe("empty state", () => {
  it("tells the owner what to do instead of showing an empty panel", () => {
    const { container } = panel(payload({ split: EMPTY_SPLIT }));
    expect(container.querySelector(".gate-empty")!.textContent).toBe(
      "Aún no hay escaneos con etiqueta. Asigna un enlace a un adhesivo y escanéalo para ver cifras aquí.",
    );
  });

  it("shows no empty note when there were scans", () => {
    expect(panel(payload()).container.querySelector(".gate-empty")).toBeNull();
  });
});

describe("the qualification travels with the number", () => {
  it("states the sample rule in the static markup", () => {
    const { text } = panel(payload());
    expect(text).toContain("Cómo leer esto: las calificaciones son opcionales");
    expect(text).toContain(`con menos de ${MIN_RATED_SAMPLE} calificaciones`);
    expect(text).toContain("Una calificación mostrada con su tamaño de muestra es una señal; sin él, no lo sería.");
  });

  it("renders the floor from meta, not a copy baked into the markup", () => {
    // If the constant moves and this panel does not, the panel starts calling a
    // mean acceptable at n=4 while the API is withholding it.
    const { text } = panel({
      ...payload({
        split: {
          google: { scans: 20, rated: 20, avgRating: 4.8 },
          private: { scans: 6, rated: 1, avgRating: null },
          totalScans: 26,
          derivationRate: 20 / 26,
          sentimentGap: null,
        },
      }),
      meta: { minRatedSample: 12, peakWindow: "7 days" },
    });
    expect(text).toContain("con menos de 12 calificaciones");
    expect(text).toContain("se necesitan 12 calificaciones en ambos grupos");
    expect(text).not.toContain("con menos de 5 calificaciones");
  });
});

// The token layer (from dashboard-tokens.test.ts): colours belong to the
// stylesheet's classes, so the panel's own markup carries none.
describe("token layer — the review-gate panel", () => {
  const coloured = payload({
    locations: [
      {
        locationId: "l1",
        locationName: "Cafe Central",
        googleScans: 3,
        googleRated: 0,
        privateScans: 4,
        privateRated: 0,
        totalScans: 7,
        derivationRate: 0.5,
      },
    ],
    peaks: [
      { bucketStart: 1_700_000_000, total: 3, google: 2, private: 1, derivationRate: 0.66 },
      { bucketStart: 1_700_086_400, total: 5, google: 4, private: 1, derivationRate: 0.8 },
    ],
  });

  it("emits no hex colour literal", () => {
    expect(panel(coloured).html.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).toEqual([]);
  });

  it("emits no colour-bearing inline style, and keeps the computed heights inline", () => {
    const styles = [...panel(coloured).html.matchAll(/style="([^"]*)"/g)].map((m) => m[1]!);
    expect(styles.filter((s) => /#[0-9a-fA-F]{3,8}\b/.test(s) || /color\s*:/.test(s) || /background\s*:/.test(s))).toEqual([]);
    // Height is data, not styling.
    expect(styles.some((s) => /height:\s*\d+%/.test(s))).toBe(true);
  });
});
