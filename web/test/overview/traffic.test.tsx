import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { HourlyTraffic, type HourlyPayload } from "../../src/overview/HourlyTraffic";

// The busy-hours chart (dashboard-react T4), ported from the Worker tests that
// compiled the legacy renderHourlyTraffic out of the served HTML.

const XSS_ATTR = '"><img src=x onerror=alert(1)>';

const payload = (scansByHour: Record<number, number>): HourlyPayload => ({
  time_zone: "America/Santiago",
  window: "30 days",
  hours: Array.from({ length: 24 }, (_, hour) => ({ hour, scans: scansByHour[hour] ?? 0 })),
});

function chart(p: HourlyPayload) {
  const { container } = render(<HourlyTraffic payload={p} />);
  return { container, html: container.innerHTML, text: container.textContent ?? "" };
}

afterEach(cleanup);

describe("busy hours chart", () => {
  it("draws one bar per hour, sized against the busiest hour", () => {
    const { container } = chart(payload({ 13: 40, 20: 10 }));
    const bars = [...container.querySelectorAll<HTMLElement>(".peak-chart > .hour-bar")];

    expect(bars).toHaveLength(24);
    expect(bars[13]!.style.height).toBe("100%");
    expect(bars[20]!.style.height).toBe("25%");
    expect(bars[0]!.style.height).toBe("0%");
    expect(bars[13]!.title).toBe("13:00 · 40 escaneos");
  });

  it("names the busiest hour and says whose clock and which period", () => {
    const { container } = chart(payload({ 13: 40, 20: 10 }));

    expect(container.querySelector(".hour-summary")!.textContent).toBe("Hora más concurrida: 13:00–14:00 (40 escaneos)");
    expect(container.querySelector(".estimate-note")!.textContent).toBe(
      "Últimos 30 días · hora de America/Santiago. Cuenta cada escaneo, incluidos los repetidos.",
    );
    expect([...container.querySelectorAll(".peak-axis span")].map((s) => s.textContent)).toEqual([
      "00:00",
      "06:00",
      "12:00",
      "18:00",
      "23:00",
    ]);
  });

  it("wraps the busiest hour past midnight", () => {
    const { container } = chart(payload({ 23: 5 }));
    expect(container.querySelector(".hour-summary")!.textContent).toBe("Hora más concurrida: 23:00–00:00 (5 escaneos)");
  });

  it("explains the empty state instead of drawing 24 flat bars", () => {
    const { container, html } = chart(payload({}));

    expect(container.querySelector(".gate-empty")!.textContent).toBe("Aún no hay escaneos en los últimos 30 días.");
    expect(html).not.toContain("hour-bar");
  });

  it("treats a payload without hours as empty", () => {
    const { container } = chart({ window: "30 days" });
    expect(container.querySelector(".gate-empty")!.textContent).toBe("Aún no hay escaneos en los últimos 30 días.");
  });

  it("prints the time zone and window as text, never as markup", () => {
    const { container, html } = chart({ ...payload({ 1: 1 }), time_zone: XSS_ATTR });

    expect(container.querySelector("img")).toBeNull();
    expect(html).not.toContain('"><img');
    expect(container.querySelector(".estimate-note")!.textContent).toContain(XSS_ATTR);
  });
});
