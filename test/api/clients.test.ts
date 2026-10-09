import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// GET /api/clients/metrics — the per-`client_ref` visitor rollup
//
// This aggregate was moved OUT of `GET /api/links`, which had to become
// `{ links, clients }` to carry it. Its metric semantics did not move with it:
// same SQL, same bind parameters, same windows. These tests exist so the move
// cannot quietly change what the numbers mean — the SQL assertions here are the
// ones removed from test/api/links.test.ts, kept intact.
// ---------------------------------------------------------------------------

vi.mock("../../src/db/client", () => ({
  withClient: vi.fn(),
}));

import { withClient } from "../../src/db/client";
import { listClientRefMetrics } from "../../src/api/clients";
import { UNIQUE_WINDOW, SESSION_WINDOW } from "../../src/analytics/metrics";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockContext(
  overrides: {
    tenant?: { tenantSlug: string; schemaName: string; tenantId: string };
  } = {},
) {
  const jsonFn = vi.fn().mockImplementation(
    (body: unknown, status: number) => new Response(JSON.stringify(body), { status }),
  );

  const c = {
    req: { json: vi.fn(), param: vi.fn().mockReturnValue("") },
    env: {
      SHORT_URL_DOMAIN: "short.link",
      SUPABASE_JWT_SECRET: "test-secret",
      SUPABASE_URL: "https://test.supabase.co",
      SUPABASE_ANON_KEY: "test-anon-key",
      SUPABASE_SERVICE_ROLE_KEY: "test-service-key",
      SHORT_URL_CACHE: {} as any,
    },
    json: jsonFn,
    get: vi.fn().mockImplementation((key: string) => {
      if (key === "tenant") {
        return overrides.tenant ?? {
          tenantSlug: "acme",
          schemaName: "tenant_a7f3",
          tenantId: "tenant-uuid",
        };
      }
      return undefined;
    }),
    executionCtx: { waitUntil: vi.fn() },
  };

  return { c, jsonFn };
}

/**
 * Records the SQL text and bind params of every query the handler issues, and
 * returns each queued ROW ARRAY in call order.
 */
function mockRecordingDb(rowSets: unknown[][]) {
  const calls: { sql: string; params: unknown[] }[] = [];
  let i = 0;

  vi.mocked(withClient).mockImplementation(async (_env: any, fn: any) =>
    fn({
      query: vi.fn().mockImplementation(async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        return { rows: rowSets[i++] ?? [], rowCount: 1 };
      }),
    }),
  );

  return calls;
}

/** One rollup row as the SQL aggregate returns it. */
function clientRow(over: Record<string, unknown> = {}) {
  return { client_ref: "ACME-0042", unique_visitors: 30, sessions: 42, ...over };
}

// ---------------------------------------------------------------------------
// Response contract
// ---------------------------------------------------------------------------

describe("listClientRefMetrics response contract", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns visitors per client_ref as a bare array", async () => {
    mockRecordingDb([[clientRow()]]);

    const { c, jsonFn } = mockContext();
    await listClientRefMetrics(c as any);

    // A bare array, for the same reason GET /api/links is one: a consumer that
    // has to unwrap an envelope to read a collection is a consumer this project
    // already broke once.
    expect(jsonFn.mock.calls[0]![0]).toEqual([
      { client_ref: "ACME-0042", unique_visitors: 30, sessions: 42 },
    ]);
  });

  it("serializes to a top-level JSON array on the wire", async () => {
    mockRecordingDb([[clientRow()]]);

    const { c } = mockContext();

    const res = (await listClientRefMetrics(c as any)) as Response;

    await expect(res.json()).resolves.toEqual([
      { client_ref: "ACME-0042", unique_visitors: 30, sessions: 42 },
    ]);
  });

  it("returns an empty array, not an error, when no link carries a client_ref", async () => {
    mockRecordingDb([[]]);

    const { c, jsonFn } = mockContext();
    await listClientRefMetrics(c as any);

    expect(jsonFn.mock.calls[0]![0]).toEqual([]);
  });

  it("coerces string-encoded counts, since bigint may arrive as a string", async () => {
    mockRecordingDb([[clientRow({ unique_visitors: "9", sessions: "11" })]]);

    const { c, jsonFn } = mockContext();
    await listClientRefMetrics(c as any);

    expect(jsonFn.mock.calls[0]![0]).toEqual([
      { client_ref: "ACME-0042", unique_visitors: 9, sessions: 11 },
    ]);
  });

  it("counts one visitor across two links sharing the same client_ref", async () => {
    // The reason this rollup exists: two tags in one shop, one shopper. Per link
    // they are 1 + 1; at the store they are 1.
    mockRecordingDb([[clientRow({ unique_visitors: 1, sessions: 1 })]]);

    const { c, jsonFn } = mockContext();
    await listClientRefMetrics(c as any);

    expect(jsonFn.mock.calls[0]![0]).toEqual([
      { client_ref: "ACME-0042", unique_visitors: 1, sessions: 1 },
    ]);
  });

  it("propagates a failed aggregate rather than reporting zero visitors", async () => {
    // A silent catch here would publish a confident "nobody came in today".
    vi.mocked(withClient).mockRejectedValue(new Error("db down"));

    const { c } = mockContext();

    await expect(listClientRefMetrics(c as any)).rejects.toThrow("db down");
  });
});

// ---------------------------------------------------------------------------
// Tenant scoping
// ---------------------------------------------------------------------------

describe("listClientRefMetrics tenant scoping", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("joins against the requesting tenant's links table", async () => {
    // `analytics.link_clicks.link_id` has no foreign key — links live in
    // per-tenant schemas — so this inner join IS the isolation boundary. Read
    // from another tenant's context, this must follow.
    const calls = mockRecordingDb([[]]);

    const { c } = mockContext({
      tenant: { tenantSlug: "globex", schemaName: "tenant_b91c", tenantId: "tenant-2" },
    });
    await listClientRefMetrics(c as any);

    expect(calls[0]!.sql).toMatch(/"tenant_b91c"\."links" l/);
    expect(calls[0]!.sql).not.toMatch(/"tenant_a7f3"/);
  });
});

// ---------------------------------------------------------------------------
// The SQL itself — unchanged by the move
// ---------------------------------------------------------------------------

describe("the rollup aggregate", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("aggregates in SQL over the tenant's links, excluding un-identified ones", async () => {
    const calls = mockRecordingDb([[]]);

    const { c } = mockContext();
    await listClientRefMetrics(c as any);

    expect(calls).toHaveLength(1);
    const rollup = calls[0]!;
    expect(rollup.sql).toMatch(/JOIN analytics\.link_clicks c ON c\.link_id = l\.id/);
    expect(rollup.sql).toMatch(/"tenant_a7f3"\."links" l/);
    expect(rollup.sql).toMatch(/l\.client_ref IS NOT NULL/);
    // Both figures from the same (visitor, bucket) de-duplicated pairs.
    expect(rollup.sql).toMatch(/SELECT DISTINCT\s+l\.client_ref,/);
    expect(rollup.sql).toMatch(/COUNT\(DISTINCT s\.ip_hash\)::int AS unique_visitors/);
    expect(rollup.sql).toMatch(/COUNT\(\*\)::int\s+AS sessions/);
    // ip_hash IS NOT NULL is required, not decorative: the session figure is a
    // COUNT(*), so without it a click with no resolvable IP counts as a person.
    expect(rollup.sql).toMatch(/c\.ip_hash IS NOT NULL/);
    expect(rollup.params).toEqual([UNIQUE_WINDOW, SESSION_WINDOW]);
  });

  it("binds every placeholder the rollup SQL references", async () => {
    // Regression guard for a real defect: the session-bucket expression was
    // shared between the two queries with a hardcoded `$3`, so the rollup
    // referenced a placeholder it never bound. Postgres rejects that at
    // execution time, long after typecheck and unit tests are green.
    const calls = mockRecordingDb([[]]);
    await listClientRefMetrics(mockContext().c as any);

    for (const q of calls) {
      // A placeholder may legitimately appear more than once — the bucket
      // expression uses $2 as both divisor and multiplier — so the invariant is
      // about the DISTINCT set being contiguous from 1, not about occurrences.
      const referenced = new Set(
        [...q.sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])),
      );
      const highest = Math.max(0, ...referenced);
      // Postgres parameters are 1-indexed and contiguous.
      expect(q.params.length).toBe(highest);
      expect([...referenced].sort((a, b) => a - b)).toEqual(
        Array.from({ length: highest }, (_, i) => i + 1),
      );
    }
  });

  it("orders busiest store first so the dashboard panel leads with real traffic", async () => {
    const calls = mockRecordingDb([[]]);
    await listClientRefMetrics(mockContext().c as any);

    expect(calls[0]!.sql).toMatch(/ORDER BY sessions DESC, s\.client_ref ASC/);
  });
});