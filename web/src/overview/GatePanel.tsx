import type { ActionSplit, LocationRollup, PeakBucket } from "../../../src/analytics/review-gate";

/**
 * THE SATISFACTION PANEL (dashboard-react T4), a port of the string renderer
 * `renderGatePanel` the legacy page injected with toString(). Same numbers,
 * labels, order and withholding rules; record data is JSX text, so a
 * location name can never become markup.
 *
 * WHY THE QUALIFICATIONS ARE IN THE MARKUP
 *
 * This screen is the monthly report: the owner screenshots it and forwards
 * it. Anything delivered as a tooltip, a hover state, or a collapsed
 * disclosure does not survive the screenshot and is therefore never read.
 * Every caveat below ships as text inside the panel, next to the number it
 * qualifies, the same discipline VISITOR_ESTIMATE_CAVEAT applies to the
 * visitor figures.
 *
 * THE SAMPLE SIZE IS NOT OPTIONAL FURNITURE
 *
 * Stars are optional, so an average here is computed from a self-selected
 * minority. A mean shown without its `n` is a number the owner will act on
 * and that the data does not support. When a branch is below the floor the
 * panel says so in place of the number.
 *
 * Colours are classes only (the token layer in the dashboard stylesheet);
 * the inline styles left are the bar heights, which are the data.
 */

/** GET /api/review-gate/metrics. */
export interface GatePanelPayload {
  split: ActionSplit;
  locations: LocationRollup[];
  peaks: PeakBucket[];
  meta: { minRatedSample: number; peakWindow: string };
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
function RatingTile({ branch, label, floor }: { branch: ActionSplit["google"]; label: string; floor: number }) {
  return (
    <div className="stat-tile">
      <div className="label">{label}</div>
      {branch.avgRating === null ? (
        <>
          <div className="value withheld">Not enough ratings</div>
          <div className="sub">{`${branch.rated} of ${branch.scans} scanned · needs ${floor}`}</div>
        </>
      ) : (
        <>
          <div className="value">
            {branch.avgRating.toFixed(2)}
            <span className="rating-of"> / 5</span>
          </div>
          <div className="sub">{`from ${branch.rated} of ${branch.scans} scanned`}</div>
        </>
      )}
    </div>
  );
}

const HOUR = 3600;

/**
 * The peak chart, as CSS bars.
 *
 * Bars rather than a charting library because this screen is screenshotted
 * and forwarded as the report: a canvas chart renders as a blank box in a
 * headless screenshot, and self-contained DOM bars do not.
 *
 * Bar HEIGHT is this bucket against the busiest one, so the chart shows
 * traffic density. Within the bar, the split is the share that reached the
 * public review flow: a proportion OF the bar, so it does not scale with
 * height.
 */
function PeakChart({ peaks }: { peaks: PeakBucket[] }) {
  if (peaks.length === 0) {
    return <p className="estimate-note gate-empty-note">No tagged scans in the last 7 days yet.</p>;
  }

  const max = peaks.reduce((m, p) => Math.max(m, p.total), 0) || 1;

  // The query only returns hours that HAD scans. Drawn as-is, a single busy
  // hour became one bar filling the whole chart, with the same timestamp on
  // both ends of the axis. Lay the buckets on a continuous hourly track
  // instead: the 7-day window (168 h) ending at the latest bucket, widened
  // only if the data spans longer.
  const byStart = new Map(peaks.map((p) => [p.bucketStart, p]));
  const last = peaks[peaks.length - 1]!.bucketStart;
  const span = Math.max(168, Math.round((last - peaks[0]!.bucketStart) / HOUR) + 1);
  const first = last - (span - 1) * HOUR;
  const slots: Array<PeakBucket | undefined> = [];
  for (let i = 0; i < span; i++) slots.push(byStart.get(first + i * HOUR));

  return (
    <>
      <div className="peak-chart">
        {slots.map((p, i) => {
          if (!p) return <div key={i} className="peak-bar" style={{ height: "0%" }}></div>;
          const height = Math.round((p.total / max) * 100);
          const googleShare = p.total > 0 ? Math.round((p.google / p.total) * 100) : 0;
          return (
            <div key={i} className="peak-bar" style={{ height: `${height}%` }} title={`${p.total} scans · ${pct(p.derivationRate)} to review`}>
              <div className="peak-seg" style={{ height: "100%" }}>
                <div className="peak-seg-public" style={{ height: `${googleShare}%` }}></div>
                <div className="peak-seg-rest" style={{ height: `${100 - googleShare}%` }}></div>
              </div>
            </div>
          );
        })}
      </div>
      <div className="peak-axis">
        <span>{new Date(first * 1000).toLocaleString()}</span>
        <span>{new Date(last * 1000).toLocaleString()}</span>
      </div>
    </>
  );
}

/** The zonal table: the pack of stickers, one row per table or zone. */
function LocationTable({ locations }: { locations: LocationRollup[] }) {
  if (locations.length === 0) return null;
  return (
    <>
      <h4 className="gate-h">By location</h4>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Location</th>
              <th>Scans</th>
              <th>To review</th>
            </tr>
          </thead>
          <tbody>
            {locations.map((l, i) => (
              <tr key={l.locationId ?? `unassigned-${i}`}>
                <td>{l.locationName ?? "Not assigned to a location"}</td>
                <td>{l.totalScans}</td>
                <td>{pct(l.derivationRate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

export function GatePanel({ payload }: { payload: GatePanelPayload }) {
  const { split, locations, peaks, meta } = payload;
  const floor = meta.minRatedSample;
  const gap = split.sentimentGap;

  return (
    <>
      {split.totalScans === 0 && (
        <p className="gate-empty">No tagged scans yet. Point a link at a sticker and scan it to see numbers here.</p>
      )}
      <div className="stat-tiles">
        <div className="stat-tile">
          <div className="label">Scans</div>
          <div className="value">{split.totalScans}</div>
          <div className="sub">{`${split.google.scans} to review · ${split.private.scans} private`}</div>
        </div>
        <div className="stat-tile">
          <div className="label">To review</div>
          <div className="value">{pct(split.derivationRate)}</div>
          <div className="sub">chose the public review link</div>
        </div>
        <RatingTile branch={split.google} label="Rating · to review" floor={floor} />
        <RatingTile branch={split.private} label="Rating · private" floor={floor} />
        <div className="stat-tile">
          <div className="label">Sentiment gap</div>
          {gap === null ? (
            <>
              <div className="value withheld">Not enough ratings</div>
              <div className="sub">{`needs ${floor} ratings in both groups`}</div>
            </>
          ) : (
            <>
              <div className="value">{`${gap > 0 ? "+" : ""}${gap.toFixed(2)}`}</div>
              <div className="sub">public minus private</div>
            </>
          )}
        </div>
      </div>
      <h4 className="gate-h">Peak hours</h4>
      <PeakChart peaks={peaks} />
      <LocationTable locations={locations} />
      <p className="estimate-note">
        <strong>How to read this:</strong>{" "}
        {`ratings are optional, so every average is computed only from customers who chose to give one, and is withheld entirely below ${floor} ratings. A rating shown with its sample size is a signal; one shown without would not be.`}
      </p>
    </>
  );
}
