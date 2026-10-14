import type {
  ActionSplit,
  LocationRollup,
  PeakBucket,
} from "../analytics/review-gate";

// ---------------------------------------------------------------------------
// The satisfaction panel.
//
// WHY THIS IS A SEPARATE MODULE
//
// `dashboard.ts` is already an 800-line template string. Adding a fourth
// aggregate panel to it inline would make the section impossible to test and
// impossible to read. The render is pure — payload in, HTML out — so it lives
// here and is exercised directly.
//
// WHY THE QUALIFICATIONS ARE IN THE MARKUP
//
// This screen is the monthly report: the owner screenshots it and forwards it.
// Anything delivered as a tooltip, a hover state, or a collapsed disclosure
// does not survive the screenshot and is therefore never read. Every caveat
// below ships as static text inside the rendered panel, next to the number it
// qualifies. That is the same discipline `VISITOR_ESTIMATE_CAVEAT` applies to
// the visitor figures, and the reason the caveat is interpolated rather than
// fetched.
//
// THE SAMPLE SIZE IS NOT OPTIONAL FURNITURE
//
// Stars are optional, so an average here is computed from a self-selected
// minority. A mean shown without its `n` is a number the owner will act on and
// that the data does not support. When a branch is below the floor the panel
// says so in place of the number — there is no way to read an average off this
// panel without also reading how many people rated.
//
// EVERYTHING BELOW IS NESTED, AND THAT IS LOAD-BEARING
//
// `dashboard.ts` ships this function to the browser by injecting its source
// with `Function.prototype.toString()`. A function that calls module-scope
// helpers throws `ReferenceError` in the browser — in the one place it actually
// runs — while every unit test here passes, because the module scope is present
// under Vitest. `test/handlers/gate-panel.test.ts` rehydrates the injected
// source in isolation to keep that failure mode closed.
// ---------------------------------------------------------------------------

export interface GatePanelPayload {
  split: ActionSplit;
  locations: LocationRollup[];
  peaks: PeakBucket[];
  meta: { minRatedSample: number; peakWindow: string };
}

export function renderGatePanel(payload: GatePanelPayload): string {
  // -------------------------------------------------------------------------
  // Helpers — nested, see the note above.
  // -------------------------------------------------------------------------

  function escapeHtml(raw: string): string {
    return raw.replace(
      /[&<>"']/g,
      (ch) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[ch]!,
    );
  }

  /** One percentage, from a 0..1 rate. */
  function pct(rate: number): string {
    return `${(rate * 100).toFixed(rate === 0 || rate === 1 ? 0 : 1)}%`;
  }

  /**
   * A mean rating, or the reason there is none.
   *
   * The withheld branch renders muted and smaller so it is visually distinct
   * from a measurement. An em dash or an empty cell would read as a bug rather
   * than as an honest "not enough data".
   */
  function ratingTile(
    branch: ActionSplit["google"],
    label: string,
    floor: number,
  ): string {
    const head = `<div class="stat-tile">
        <div class="label">${escapeHtml(label)}</div>`;

    if (branch.avgRating === null) {
      return `${head}
          <div class="value withheld">Not enough ratings</div>
          <div class="sub">${branch.rated} of ${branch.scans} scanned · needs ${floor}</div>
        </div>`;
    }

    return `${head}
        <div class="value">${branch.avgRating.toFixed(2)}<span class="rating-of"> / 5</span></div>
        <div class="sub">from ${branch.rated} of ${branch.scans} scanned</div>
      </div>`;
  }

  /**
   * The peak chart, as CSS bars.
   *
   * Bars rather than a charting library because this screen is screenshotted
   * and forwarded as the report — a canvas chart renders as a blank box in a
   * headless screenshot, and self-contained DOM bars do not.
   *
   * Bar HEIGHT is this bucket against the busiest one, so the chart shows
   * traffic density. A chart whose tallest bar is always full regardless of
   * volume is decoration, not information. Within the bar, the split is the
   * share that reached the public review flow — a proportion OF the bar, so it
   * does not scale with height.
   */
  function peakChart(peaks: PeakBucket[]): string {
    if (peaks.length === 0) {
      return `<p class="estimate-note gate-empty-note">
        No tagged scans in the last 7 days yet.</p>`;
    }

    const max = peaks.reduce((m, p) => Math.max(m, p.total), 0) || 1;

    const bars = peaks
      .map((p) => {
        const height = Math.round((p.total / max) * 100);
        const googleShare =
          p.total > 0 ? Math.round((p.google / p.total) * 100) : 0;

        // Only the HEIGHTS stay inline: they are the data. Every colour is a
        // class, so the token layer can still reach it.
        return `<div class="peak-bar" style="height:${height}%;"
                       title="${p.total} scans · ${pct(p.derivationRate)} to review">
              <div class="peak-seg" style="height:100%;">
                <div class="peak-seg-public" style="height:${googleShare}%;"></div>
                <div class="peak-seg-rest" style="height:${100 - googleShare}%;"></div>
              </div>
            </div>`;
      })
      .join("");

    return `<div class="peak-chart">${bars}</div>
      <div class="peak-axis">
        <span>${new Date(peaks[0]!.bucketStart * 1000).toLocaleString()}</span>
        <span>${new Date(peaks[peaks.length - 1]!.bucketStart * 1000).toLocaleString()}</span>
      </div>`;
  }

  /** The zonal table — the pack of stickers, one row per table or zone. */
  function locationTable(locations: LocationRollup[]): string {
    if (locations.length === 0) return "";

    const rows = locations
      .map((l) => {
        const name = l.locationName ?? "Not assigned to a location";
        return `<tr>
              <td>${escapeHtml(name)}</td>
              <td>${l.totalScans}</td>
              <td>${pct(l.derivationRate)}</td>
            </tr>`;
      })
      .join("");

    return `<h4 class="gate-h">
        By location
      </h4>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Location</th><th>Scans</th><th>To review</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  }

  // -------------------------------------------------------------------------
  // The panel
  // -------------------------------------------------------------------------

  const { split, locations, peaks, meta } = payload;
  const floor = meta.minRatedSample;

  const gap = split.sentimentGap;

  const gapTile =
    gap === null
      ? `<div class="value withheld">Not enough ratings</div>
         <div class="sub">needs ${floor} ratings in both groups</div>`
      : `<div class="value">${gap > 0 ? "+" : ""}${gap.toFixed(2)}</div>
         <div class="sub">public minus private</div>`;

  const tiles = `<div class="stat-tiles">
      <div class="stat-tile">
        <div class="label">Scans</div>
        <div class="value">${split.totalScans}</div>
        <div class="sub">${split.google.scans} to review · ${split.private.scans} private</div>
      </div>
      <div class="stat-tile">
        <div class="label">To review</div>
        <div class="value">${pct(split.derivationRate)}</div>
        <div class="sub">chose the public review link</div>
      </div>
      ${ratingTile(split.google, "Rating · to review", floor)}
      ${ratingTile(split.private, "Rating · private", floor)}
      <div class="stat-tile">
        <div class="label">Sentiment gap</div>
        ${gapTile}
      </div>
    </div>`;

  const empty =
    split.totalScans === 0
      ? `<p class="gate-empty">
           No tagged scans yet. Point a link at a sticker and scan it to see numbers here.
         </p>`
      : "";

  return `${empty}${tiles}
    <h4 class="gate-h">
      Peak hours
    </h4>
    ${peakChart(peaks)}
    ${locationTable(locations)}
    <p class="estimate-note">
      <strong>How to read this:</strong> ratings are optional, so every average is
      computed only from customers who chose to give one, and is withheld entirely
      below ${floor} ratings. A rating shown with its sample size is a signal;
      one shown without would not be.
    </p>`;
}