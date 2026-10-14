import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/db/client", () => ({ withClient: vi.fn() }));
vi.mock("../../src/api/links", () => ({ resolveRegistryEntry: vi.fn() }));

import { withClient } from "../../src/db/client";
import { resolveRegistryEntry } from "../../src/api/links";
import { gateHandler } from "../../src/handlers/gate";

const GOOGLE_URL = "https://search.google.com/local/writereview?placeid=abc";

function resolvedEntry(over: Record<string, unknown> = {}) {
  return {
    tenantId: "tenant-uuid",
    schemaName: "tenant_a7f3",
    tenantSalt: "salt-abc",
    subdomain: "sabores",
    linkId: "link-uuid",
    displayName: "Sabores",
    ...over,
  } as any;
}

/** Captures every statement, so a test asserts what was written, not just status. */
function mockDb(rows: unknown[][] = [[], []]) {
  const calls: { sql: string; params: unknown[] }[] = [];
  let i = 0;
  vi.mocked(withClient).mockImplementation(async (_env: any, fn: any) =>
    fn({
      query: vi.fn().mockImplementation(async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        return { rows: rows[i++] ?? [], rowCount: 1 };
      }),
    }),
  );
  return calls;
}

/**
 * The default row set: an empty tag_ratings/feedback write, then the
 * destination read. A test asserting on the write passes its own rows.
 */
const DESTINATION_ROWS = [
  [{ original_url: GOOGLE_URL }],
];

function mockContext(body: string, formType = "application/x-www-form-urlencoded") {
  const jsonFn = vi.fn().mockImplementation(
    (b: unknown, s: number) => new Response(JSON.stringify(b), { status: s }),
  );
  // waitUntil must actually start the promise it is handed, the way the real
  // ExecutionContext does. A bare vi.fn() would leave the deferred INSERT
  // running past the assertions, so tests asserting on writes would read an
  // empty capture and pass or fail for the wrong reason.
  const pending: Promise<unknown>[] = [];
  const waitUntilFn = vi.fn((p: Promise<unknown>) => {
    pending.push(p);
  });
  return {
    c: {
      req: {
        raw: new Request("https://short.link/api/gate", { method: "POST" }),
        text: vi.fn().mockResolvedValue(body),
        header: vi.fn().mockReturnValue(formType),
      },
      env: { SHORT_URL_DOMAIN: "short.link" } as any,
      json: jsonFn,
      waitUntil: waitUntilFn,
      executionCtx: { waitUntil: waitUntilFn },
    },
    jsonFn,
    waitUntilFn,
    /** Drains the deferred writes so assertions see them. */
    flush: () => Promise.allSettled(pending),
  };
}

// ---------------------------------------------------------------------------
// T2.5 — POST /api/gate
// ---------------------------------------------------------------------------

describe("POST /api/gate", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(resolveRegistryEntry).mockResolvedValue(resolvedEntry());
    mockDb([[], ...DESTINATION_ROWS]);
  });

  it("returns the destination URL verbatim when the customer picks Google", async () => {
    const { c, jsonFn } = mockContext("code=mesa-01&action_taken=google_redirect");

    await gateHandler(c as any, vi.fn() as any);

    expect(jsonFn).toHaveBeenCalledWith({ redirectUrl: GOOGLE_URL }, 200);
  });

  // The compliance guarantee. If a rating ever becomes a reason to withhold the
  // link, this fails.
  it("returns the destination URL regardless of any rating supplied", async () => {
    for (const rating of ["1", "3", "5", ""]) {
      vi.resetAllMocks();
      vi.mocked(resolveRegistryEntry).mockResolvedValue(resolvedEntry());
      mockDb([[], ...DESTINATION_ROWS]);

      const { c, jsonFn } = mockContext(
        `code=mesa-01&action_taken=google_redirect&rating=${rating}`,
      );

      await gateHandler(c as any, vi.fn() as any);

      expect(jsonFn).toHaveBeenCalledWith({ redirectUrl: GOOGLE_URL }, 200);
    }
  });

  it("writes a tag_ratings row with the chosen action", async () => {
    const calls = mockDb([[], ...DESTINATION_ROWS]);
    const { c, flush } = mockContext("code=mesa-01&action_taken=google_redirect&rating=5");

    await gateHandler(c as any, vi.fn() as any);
    await flush();

    const insert = calls.find((q) => q.sql.includes("tag_ratings"));
    expect(insert).toBeDefined();
    expect(insert!.sql).toMatch(/INSERT\s+INTO\s+analytics\.tag_ratings/i);
    expect(insert!.params).toContain("google_redirect");
    expect(insert!.params).toContain(5);
  });

  it("records the rating as NULL when the customer skips the stars", async () => {
    const calls = mockDb([[], ...DESTINATION_ROWS]);
    const { c, flush } = mockContext("code=mesa-01&action_taken=google_redirect");

    await gateHandler(c as any, vi.fn() as any);
    await flush();

    const insert = calls.find((q) => q.sql.includes("tag_ratings"));
    // Param order is (tenant_id, link_id, rating, action_taken).
    expect(insert!.params[2]).toBeNull();
  });

  it("stores the comment in tag_feedback on the private branch", async () => {
    const calls = mockDb([[], ...DESTINATION_ROWS]);
    const { c, flush } = mockContext(
      "code=mesa-01&action_taken=internal_feedback&rating=2&comment=La+camarera+lleg%C3%B3+20+min+tarde&customer_contact=juan%40mail.com",
    );

    await gateHandler(c as any, vi.fn() as any);
    await flush();

    const insert = calls.find((q) => q.sql.includes("tag_feedback"));
    expect(insert).toBeDefined();
    expect(insert!.params).toContain("La camarera llegó 20 min tarde");
    expect(insert!.params).toContain("juan@mail.com");
  });

  it("acknowledges the private branch with the thanks page, not a JSON envelope", async () => {
    const { c, jsonFn } = mockContext(
      "code=mesa-01&action_taken=internal_feedback&comment=Hola",
    );

    const res = (await gateHandler(c as any, vi.fn() as any)) as Response;

    expect(jsonFn).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toMatch(/text\/html/i);
    await expect(res.text()).resolves.toContain("Gracias");
  });

  it("rejects an action outside the two legal branches", async () => {
    const { c, jsonFn } = mockContext("code=mesa-01&action_taken=totally_made_up");

    await gateHandler(c as any, vi.fn() as any);

    expect(jsonFn).toHaveBeenCalledWith(
      expect.objectContaining({ error: "invalid_request" }),
      400,
    );
  });

  it("rejects a rating outside 1..5 rather than storing it", async () => {
    const calls = mockDb([[], ...DESTINATION_ROWS]);
    const { c, jsonFn } = mockContext(
      "code=mesa-01&action_taken=google_redirect&rating=99",
    );

    await gateHandler(c as any, vi.fn() as any);
    await Promise.resolve();

    expect(jsonFn).toHaveBeenCalledWith(
      expect.objectContaining({ error: "invalid_request" }),
      400,
    );
    expect(calls.find((q) => q.sql.includes("tag_ratings"))).toBeUndefined();
  });

  it("requires a comment on the private branch", async () => {
    const { c, jsonFn } = mockContext(
      "code=mesa-01&action_taken=internal_feedback&comment=",
    );

    await gateHandler(c as any, vi.fn() as any);

    expect(jsonFn).toHaveBeenCalledWith(
      expect.objectContaining({ error: "invalid_request" }),
      400,
    );
  });

  it("caps the comment length so a body cannot be used as free storage", async () => {
    const { c, jsonFn } = mockContext(
      `code=mesa-01&action_taken=internal_feedback&comment=${"x".repeat(5000)}`,
    );

    await gateHandler(c as any, vi.fn() as any);

    expect(jsonFn).toHaveBeenCalledWith(
      expect.objectContaining({ error: "invalid_request" }),
      400,
    );
  });

  it("returns 404 for a code that does not resolve", async () => {
    vi.mocked(resolveRegistryEntry).mockResolvedValue(null);

    const { c, jsonFn } = mockContext("code=nope&action_taken=google_redirect");

    await gateHandler(c as any, vi.fn() as any);

    // `{ error, code }` is the shape src/middleware/error.ts produces; a new
    // endpoint should not invent a third error dialect.
    expect(jsonFn).toHaveBeenCalledWith(
      { error: "not_found", code: "not_found" },
      404,
    );
  });

  it("rejects a missing or malformed code without touching the database", async () => {
    const calls = mockDb();
    const { c, jsonFn } = mockContext("action_taken=google_redirect");

    await gateHandler(c as any, vi.fn() as any);

    expect(jsonFn).toHaveBeenCalledWith(
      expect.objectContaining({ error: "invalid_request" }),
      400,
    );
    expect(calls).toHaveLength(0);
  });
});