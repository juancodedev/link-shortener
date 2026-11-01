import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// GET /api/traffic/hourly — scans per hour of the day
//
// The owner reads this as "when are my busy hours", so the two things that
// would quietly make it lie are pinned here: the hour must be the store's local
// hour (a UTC bucket shifts a lunch rush to 16:00), and every hour of the day
// must be present (a missing bar reads as "closed", not "zero").
// ---------------------------------------------------------------------------

vi.mock("../../src/db/client", () => ({
  withClient: vi.fn(),
}));

import { withClient } from "../../src/db/client";
import { hourlyTraffic } from "../../src/api/traffic";
import {
  BUSINESS_TIME_ZONE,
  HOURLY_WINDOW,
  buildHourlyTrafficQuery,
  toHourlyHistogram,
} from "../../src/analytics/metrics";

function mockContext() {
  const jsonFn = vi
    .fn()
    .mockImplementation(
      (body: unknown, status = 200) => new Response(JSON.stringify(body), { status }),
    );
  const c = {
    env: {},
    json: jsonFn,
    get: vi.fn().mockImplementation((key: string) =>
      key === "tenant"
        ? { tenantSlug: "acme", schemaName: "tenant_a7f3", tenantId: "tenant-uuid" }
        : undefined,
    ),
  };
  return { c, jsonFn };
}

function mockRecordingDb(rows: unknown[]) {
  const calls: { sql: string; params: unknown[] }[] = [];
  vi.mocked(withClient).mockImplementation(async (_env: any, fn: any) =>
    fn({
      query: vi.fn().mockImplementation(async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        return { rows, rowCount: rows.length };
      }),
    }),
  );
  return calls;
}

describe("buildHourlyTrafficQuery", () => {
  it("buckets by the store's local hour, scoped to one tenant and the window", () => {
    const q = buildHourlyTrafficQuery("tenant-uuid");

    expect(q.text).toContain("AT TIME ZONE $2");
    expect(q.text).toContain("extract(hour FROM");
    expect(q.text).toContain("c.tenant_id = $1");
    expect(q.text).toContain("NOW() - CAST($3 AS interval)");
    expect(q.params).toEqual(["tenant-uuid", BUSINESS_TIME_ZONE, HOURLY_WINDOW]);
  });

  it("uses Chile's time zone and a 30-day window", () => {
    expect(BUSINESS_TIME_ZONE).toBe("America/Santiago");
    expect(HOURLY_WINDOW).toBe("30 days");
  });
});

describe("toHourlyHistogram", () => {
  it("returns all 24 hours in order, filling hours without scans with zero", () => {
    const hours = toHourlyHistogram([
      { hour: 13, scans: "42" },
      { hour: 0, scans: 3 },
    ]);

    expect(hours).toHaveLength(24);
    expect(hours.map((h) => h.hour)).toEqual(Array.from({ length: 24 }, (_, i) => i));
    expect(hours[0]).toEqual({ hour: 0, scans: 3 });
    expect(hours[13]).toEqual({ hour: 13, scans: 42 });
    expect(hours[12]).toEqual({ hour: 12, scans: 0 });
  });

  it("returns 24 zero hours when there was no traffic", () => {
    const hours = toHourlyHistogram([]);

    expect(hours).toHaveLength(24);
    expect(hours.every((h) => h.scans === 0)).toBe(true);
  });
});

describe("hourlyTraffic handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("answers the window, the time zone and 24 hourly buckets", async () => {
    const calls = mockRecordingDb([{ hour: 20, scans: 7 }]);
    const { c } = mockContext();

    const res = await hourlyTraffic(c as any, vi.fn());
    const body = (await (res as Response).json()) as any;

    expect((res as Response).status).toBe(200);
    expect(body.time_zone).toBe("America/Santiago");
    expect(body.window).toBe("30 days");
    expect(body.hours).toHaveLength(24);
    expect(body.hours[20]).toEqual({ hour: 20, scans: 7 });
    expect(calls).toHaveLength(1);
    expect(calls[0].params[0]).toBe("tenant-uuid");
  });

  it("fails instead of reporting zero traffic when the query fails", async () => {
    vi.mocked(withClient).mockRejectedValue(new Error("db down"));
    const { c } = mockContext();

    await expect(hourlyTraffic(c as any, vi.fn())).rejects.toThrow("db down");
  });
});
