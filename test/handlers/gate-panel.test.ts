import { describe, it, expect } from "vitest";
import { renderGatePanel, type GatePanelPayload } from "../../src/handlers/gate-panel";
import { MIN_RATED_SAMPLE } from "../../src/analytics/review-gate";

// ---------------------------------------------------------------------------
// The satisfaction panel.
//
// This screen is what the owner screenshots and forwards as their monthly
// report, so the tests here are mostly about one thing: nothing may be readable
// on this panel without its qualification next to it.
// ---------------------------------------------------------------------------

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

describe("headline figures", () => {
  it("shows the scan count and both branches", () => {
    const html = renderGatePanel(payload());
    expect(html).toContain("26");
    expect(html).toContain("20 to review");
    expect(html).toContain("6 private");
  });

  it("shows the derivation rate as a percentage", () => {
    // 20/26 = 76.9%, not 0.77. An owner reads this panel, not JSON.
    const html = renderGatePanel(payload());
    expect(html).toContain("76.9%");
  });

  it("renders zero as 0% rather than an empty cell", () => {
    const html = renderGatePanel(
      payload({
        split: {
          google: { scans: 0, rated: 0, avgRating: null },
          private: { scans: 0, rated: 0, avgRating: null },
          totalScans: 0,
          derivationRate: 0,
          sentimentGap: null,
        },
      }),
    );
    expect(html).toContain("0%");
  });
});

describe("every average ships with its sample size", () => {
  it("shows n beside the mean for both branches", () => {
    const html = renderGatePanel(payload());
    expect(html).toContain("from 12 of 20");
    expect(html).toContain("from 6 of 6");
  });

  it("withholds the mean and says why when a branch is under the floor", () => {
    const html = renderGatePanel(
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
    expect(html).not.toContain("4.60");
    expect(html).toContain("Not enough ratings");
    // ...and the reader learns how far short it fell.
    expect(html).toContain(`needs ${MIN_RATED_SAMPLE}`);
    // ...and still sees the raw counts, which are information regardless.
    expect(html).toContain("2 of 20");
  });

  it("never renders a bare dash that could read as a bug", () => {
    const html = renderGatePanel(
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
    const html = renderGatePanel(payload());
    expect(html).toContain("+2.20");
    expect(html).toContain("public minus private");
  });

  it("withholds it when either branch is short, and names the requirement", () => {
    const html = renderGatePanel(
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
    expect(html).not.toContain("+4.80");
    expect(html).toContain(`needs ${MIN_RATED_SAMPLE} ratings in both groups`);
  });

  it("signs a negative gap rather than showing a bare number", () => {
    const html = renderGatePanel(
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
    expect(html).toContain("-1.30");
  });
});

describe("per-location table", () => {
  it("labels an unassigned scan rather than showing an empty cell", () => {
    const html = renderGatePanel(
      payload({
        locations: [
          {
            locationId: null,
            locationName: null,
            googleScans: 3,
            googleRated: 0,
            privateScans: 1,
            privateRated: 0,
            totalScans: 4,
            derivationRate: 0.75,
          },
        ],
      }),
    );
    expect(html).toContain("Not assigned to a location");
  });

  it("escapes a location name from the database", () => {
    // The name is owner-supplied. A location called `<img onerror=...>` must
    // not become markup on the screen the owner screenshots.
    const html = renderGatePanel(
      payload({
        locations: [
          {
            locationId: "loc-1",
            locationName: "<script>alert(1)</script>",
            googleScans: 1,
            googleRated: 0,
            privateScans: 0,
            privateRated: 0,
            totalScans: 1,
            derivationRate: 1,
          },
        ],
      }),
    );
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("renders no table at all when there are no locations", () => {
    expect(renderGatePanel(payload())).not.toContain("<tbody>");
  });
});

describe("peak chart", () => {
  it("draws one bar per bucket", () => {
    const html = renderGatePanel(
      payload({
        peaks: [
          { bucketStart: 1767225600, google: 3, private: 1, total: 4, derivationRate: 0.75 },
          { bucketStart: 1767229200, google: 1, private: 3, total: 4, derivationRate: 0.25 },
        ],
      }),
    );
    expect((html.match(/class="peak-bar"/g) ?? []).length).toBe(2);
  });

  it("says so when there is no traffic, instead of drawing an empty chart", () => {
    const html = renderGatePanel(payload());
    expect(html).toContain("No tagged scans");
  });

  it("scales bars against the busiest bucket", () => {
    // A chart where the tallest bar is always full regardless of volume is
    // decoration, not information.
    const html = renderGatePanel(
      payload({
        peaks: [
          { bucketStart: 1, google: 1, private: 0, total: 1, derivationRate: 1 },
          { bucketStart: 2, google: 4, private: 0, total: 4, derivationRate: 1 },
        ],
      }),
    );
    // 4 scans against a max of 4 fills the bar; 1 against 4 is a quarter.
    expect(html).toContain('style="height:100%;background:transparent;"');
    expect(html).toContain('style="height:25%;background:transparent;"');
  });
});

describe("empty state", () => {
  it("tells the owner what to do instead of showing an empty panel", () => {
    const html = renderGatePanel(
      payload({
        split: {
          google: { scans: 0, rated: 0, avgRating: null },
          private: { scans: 0, rated: 0, avgRating: null },
          totalScans: 0,
          derivationRate: 0,
          sentimentGap: null,
        },
      }),
    );
    expect(html).toContain("No tagged scans yet");
  });
});

describe("the qualification travels with the number", () => {
  it("states the sample rule in the static markup", () => {
    const html = renderGatePanel(payload());
    expect(html).toContain("ratings are optional");
    expect(html).toContain(`below ${MIN_RATED_SAMPLE} ratings`);
  });

  it("renders the floor from meta, not a copy baked into the markup", () => {
    // If the constant moves and this panel does not, the panel starts calling a
    // mean acceptable at n=4 while the API is withholding it.
    const html = renderGatePanel({
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
    expect(html).toContain("below 12 ratings");
    expect(html).toContain("needs 12 ratings in both groups");
    expect(html).not.toContain("below 5 ratings");
  });
});
// ---------------------------------------------------------------------------
// The injection guard
//
// `dashboard.ts` ships this function to the browser with
// `Function.prototype.toString()` and evals it inside a <script>. Every other
// test in this file passes against the module, where module scope exists — so a
// reference to a module-scope helper is invisible to all of them and throws
// `ReferenceError` in the one place the function actually runs.
//
// These tests rebuild the function from its OWN source, with no module around
// it, which is what the browser gets.
// ---------------------------------------------------------------------------

describe("the injected source is self-contained", () => {
  /** Rebuild exactly what the browser receives: source text, no module. */
  function rehydrate(): (p: GatePanelPayload) => string {
    const source = renderGatePanel.toString();
    // eslint-disable-next-line no-new-func
    return new Function(`return (${source})`)() as (p: GatePanelPayload) => string;
  }

  it("evaluates and runs with nothing else in scope", () => {
    const standalone = rehydrate();
    expect(() => standalone(payload())).not.toThrow();
  });

  it("renders the same output as the module version", () => {
    expect(rehydrate()(payload())).toBe(renderGatePanel(payload()));
  });

  it("exercises every branch without a module-scope helper", () => {
    const standalone = rehydrate();

    // Every path through the body, so a helper used by only one of them is
    // still proven to be in scope.
    const cases = [
      payload(), // full data, peaks, locations absent
      payload({
        split: {
          google: { scans: 0, rated: 0, avgRating: null },
          private: { scans: 0, rated: 0, avgRating: null },
          totalScans: 0,
          derivationRate: 0,
          sentimentGap: null,
        },
      }), // empty state
      payload({
        peaks: [
          { bucketStart: 1, google: 2, private: 1, total: 3, derivationRate: 0.66 },
          { bucketStart: 2, google: 1, private: 3, total: 4, derivationRate: 0.25 },
        ],
      }), // peak chart
      payload({
        locations: [
          {
            locationId: "l1",
            locationName: "Mesa <1>",
            googleScans: 2,
            googleRated: 1,
            privateScans: 1,
            privateRated: 0,
            totalScans: 3,
            derivationRate: 2 / 3,
          },
        ],
      }), // location table + escaping
    ];

    for (const c of cases) {
      expect(() => standalone(c)).not.toThrow();
      expect(standalone(c).length).toBeGreaterThan(0);
    }
  });
});
