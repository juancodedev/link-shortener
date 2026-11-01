import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// The print queue: GET /api/links/print-queue and POST /api/links/printed
// (odd/tasks/print-queue-cards.md S2-S3)
// ---------------------------------------------------------------------------

vi.mock("../../src/db/client", () => ({
  withClient: vi.fn(),
}));

import { withClient } from "../../src/db/client";
import { listPrintQueue, markPrinted } from "../../src/api/print-queue";
import { ValidationError } from "../../src/middleware/error";

const ID_A = "11111111-1111-4111-8111-111111111111";
const ID_B = "22222222-2222-4222-8222-222222222222";

function mockContext(body: unknown = {}) {
  const jsonFn = vi
    .fn()
    .mockImplementation(
      (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status }),
    );
  const c = {
    req: { json: vi.fn().mockResolvedValue(body) },
    env: { SHORT_URL_DOMAIN: "masresenas.cl" },
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

describe("GET /api/links/print-queue", () => {
  beforeEach(() => vi.resetAllMocks());

  it("lists queued links, oldest first, with the short URL each QR encodes", async () => {
    const calls = mockRecordingDb([
      { id: ID_A, short_code: "Kp2mZrQ", print_queued_at: "2026-11-01T10:00:00Z" },
      { id: ID_B, short_code: "aB9xYt1", print_queued_at: "2026-11-01T11:00:00Z" },
    ]);
    const { c, jsonFn } = mockContext();

    await listPrintQueue(c as any, vi.fn());

    expect(calls[0]!.sql).toContain('"tenant_a7f3"."links"');
    expect(calls[0]!.sql).toMatch(/WHERE print_queued_at IS NOT NULL/);
    expect(calls[0]!.sql).toMatch(/ORDER BY print_queued_at ASC/);
    expect(jsonFn).toHaveBeenCalledWith([
      {
        id: ID_A,
        short_code: "Kp2mZrQ",
        short_url: "https://masresenas.cl/Kp2mZrQ",
        print_queued_at: "2026-11-01T10:00:00Z",
      },
      {
        id: ID_B,
        short_code: "aB9xYt1",
        short_url: "https://masresenas.cl/aB9xYt1",
        print_queued_at: "2026-11-01T11:00:00Z",
      },
    ]);
  });

  it("answers an empty array when nothing is queued", async () => {
    mockRecordingDb([]);
    const { c, jsonFn } = mockContext();

    await listPrintQueue(c as any, vi.fn());

    expect(jsonFn).toHaveBeenCalledWith([]);
  });
});

describe("POST /api/links/printed", () => {
  beforeEach(() => vi.resetAllMocks());

  it("takes the given links out of the queue and says how many left it", async () => {
    const calls = mockRecordingDb([{ id: ID_A }, { id: ID_B }]);
    const { c, jsonFn } = mockContext({ ids: [ID_A, ID_B] });

    await markPrinted(c as any, vi.fn());

    expect(calls[0]!.sql).toMatch(/UPDATE "tenant_a7f3"\."links"\s+SET print_queued_at = NULL/);
    expect(calls[0]!.sql).toMatch(/WHERE id = ANY\(\$1::uuid\[\]\)\s+AND print_queued_at IS NOT NULL/);
    expect(calls[0]!.params).toEqual([[ID_A, ID_B]]);
    expect(jsonFn).toHaveBeenCalledWith({ cleared: 2 });
  });

  it.each([
    ["a missing ids", {}],
    ["an empty list", { ids: [] }],
    ["a non-array", { ids: ID_A }],
    ["a malformed id", { ids: ["not-a-uuid"] }],
    ["more than 200 ids", { ids: Array.from({ length: 201 }, () => ID_A) }],
  ])("rejects %s before touching the database", async (_label, body) => {
    const { c } = mockContext(body);

    await expect(markPrinted(c as any, vi.fn())).rejects.toThrow(ValidationError);
    expect(withClient).not.toHaveBeenCalled();
  });
});
