/** GET /api/traffic/hourly: scans per local hour of the day over a window. */
export type HourlyPayload = {
  time_zone?: string;
  window?: string;
  hours?: Array<{ hour: number; scans: number }>;
};

const label = (h: number) => String(h).padStart(2, "0") + ":00";

/**
 * The busy-hours chart (dashboard-react T4, a port of the legacy
 * renderHourlyTraffic): 24 CSS bars, one per local hour of the day.
 *
 * Bar height is the hour against the busiest one, like the peak chart in the
 * satisfaction panel. The busiest hour is also written out as text, because a
 * screenshot of bars alone does not say which bar is 13:00, and the window
 * and time zone are printed under the chart rather than in a tooltip.
 */
export function HourlyTraffic({ payload }: { payload: HourlyPayload }) {
  const hours = Array.isArray(payload.hours) ? payload.hours : [];
  const busiest = hours.reduce((top, h) => (h.scans > top.scans ? h : top), { hour: 0, scans: 0 });
  if (busiest.scans === 0) {
    return <p className="gate-empty">{`No scans in the last ${payload.window ?? ""} yet.`}</p>;
  }
  return (
    <>
      <p className="hour-summary">
        {`Busiest hour: ${label(busiest.hour)}–${label((busiest.hour + 1) % 24)} (${busiest.scans} scans)`}
      </p>
      <div className="peak-chart">
        {hours.map((h) => (
          <div
            key={h.hour}
            className="hour-bar"
            style={{ height: `${Math.round((h.scans / busiest.scans) * 100)}%` }}
            title={`${label(h.hour)} · ${h.scans} scans`}
          ></div>
        ))}
      </div>
      <div className="peak-axis">
        <span>00:00</span>
        <span>06:00</span>
        <span>12:00</span>
        <span>18:00</span>
        <span>23:00</span>
      </div>
      <p className="estimate-note">
        {`Last ${payload.window ?? ""} · ${payload.time_zone ?? ""} time. Every scan counts, including repeat scans.`}
      </p>
    </>
  );
}
