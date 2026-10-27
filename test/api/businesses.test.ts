import { describe, it, expect, beforeEach, vi } from "vitest";
import { listBusinesses, createBusiness, updateBusiness } from "../../src/api/businesses";
import { withClient } from "../../src/db/client";
import { ValidationError, NotFoundError } from "../../src/middleware/error";

// ---------------------------------------------------------------------------
// Businesses API — the "local" that groups one or more branches (locations).
//
// Same discipline as the locations API: every query filters on `tenant_id`,
// because "a valid uuid" is not "yours".
// ---------------------------------------------------------------------------

vi.mock("../../src/db/client", () => ({ withClient: vi.fn() }));

const TENANT = {
  tenantSlug: "acme",
  schemaName: "tenant_a7f3",
  tenantId: "tenant-uuid",
  tenantSalt: "salt",
};

function mockContext(body?: unknown, params?: Record<string, string>) {
  const jsonFn = vi.fn().mockImplementation(
    (b: unknown, s: number) => new Response(JSON.stringify(b), { status: s }),
  );
  return {
    c: {
      req: {
        json: vi.fn().mockImplementation(async () => {
          if (body === undefined) throw new Error("no body");
          return body;
        }),
        param: vi.fn().mockImplementation((n: string) => params?.[n] ?? ""),
      },
      env: {} as any,
      json: jsonFn,
      get: vi.fn().mockImplementation((k: string) => (k === "tenant" ? TENANT : undefined)),
    },
    jsonFn,
  };
}

function mockDb(handlers: (sql: string, params: unknown[]) => unknown[]) {
  const calls: { sql: string; params: unknown[] }[] = [];
  vi.mocked(withClient).mockImplementation(async (_env: any, fn: any) =>
    fn({
      query: vi.fn().mockImplementation(async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        const rows = handlers(sql, params);
        return { rows, rowCount: rows.length };
      }),
    }),
  );
  return calls;
}

const BUSINESS_ROW = {
  id: "biz-1",
  name: "Café Central",
  is_active: true,
  created_at: "2026-01-01T00:00:00Z",
};

describe("GET /api/businesses", () => {
  beforeEach(() => vi.clearAllMocks());

  it("lists the tenant's locales with a branch count each, as a number", async () => {
    const calls = mockDb(() => [{ ...BUSINESS_ROW, location_count: "2" }]);

    const { c, jsonFn } = mockContext();
    await listBusinesses(c as any, vi.fn() as any);

    expect(calls[0]!.sql).toContain("b.tenant_id = $1");
    expect(calls[0]!.params).toContain("tenant-uuid");
    expect(jsonFn.mock.calls[0]![0]).toEqual({
      businesses: [{ id: "biz-1", name: "Café Central", is_active: true, location_count: 2 }],
    });
  });

  it("returns an empty list for a tenant that has none", async () => {
    mockDb(() => []);
    const { c, jsonFn } = mockContext();
    await listBusinesses(c as any, vi.fn() as any);
    expect(jsonFn.mock.calls[0]![0]).toEqual({ businesses: [] });
  });
});

describe("POST /api/businesses", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates a local for the tenant and returns it with 201", async () => {
    const calls = mockDb(() => [BUSINESS_ROW]);

    const { c, jsonFn } = mockContext({ name: "  Café Central  " });
    await createBusiness(c as any, vi.fn() as any);

    expect(calls[0]!.sql).toMatch(/INSERT INTO public\.businesses \(tenant_id, name\)/);
    expect(calls[0]!.params).toEqual(["tenant-uuid", "Café Central"]);
    expect(jsonFn).toHaveBeenCalledWith(
      { business: { id: "biz-1", name: "Café Central", is_active: true, location_count: 0 } },
      201,
    );
  });

  it("reports a duplicate name as a 409 naming the collision", async () => {
    mockDb(() => {
      throw new Error('duplicate key value violates unique constraint "idx_businesses_tenant_name"');
    });

    const { c } = mockContext({ name: "Café Central" });
    await expect(createBusiness(c as any, vi.fn() as any)).rejects.toMatchObject({
      code: "name_taken",
    });
  });

  it.each([
    ["an empty name", { name: "   " }],
    ["a non-string name", { name: 42 }],
    ["a name over the limit", { name: "x".repeat(121) }],
  ])("rejects %s", async (_label, body) => {
    const calls = mockDb(() => []);
    const { c } = mockContext(body);
    await expect(createBusiness(c as any, vi.fn() as any)).rejects.toBeInstanceOf(ValidationError);
    expect(calls).toHaveLength(0);
  });
});

describe("PATCH /api/businesses/:id", () => {
  beforeEach(() => vi.clearAllMocks());

  it("renames a local, scoped by tenant", async () => {
    const calls = mockDb(() => [BUSINESS_ROW]);

    const { c, jsonFn } = mockContext({ name: "Café Central SpA" }, { id: "biz-1" });
    await updateBusiness(c as any, vi.fn() as any);

    expect(calls[0]!.sql).toMatch(/UPDATE public\.businesses SET name = \$1/);
    expect(calls[0]!.sql).toMatch(/WHERE id = \$2 AND tenant_id = \$3/);
    expect(calls[0]!.params).toEqual(["Café Central SpA", "biz-1", "tenant-uuid"]);
    expect(jsonFn).toHaveBeenCalledWith({ ok: true });
  });

  it("switches a local off", async () => {
    const calls = mockDb(() => [BUSINESS_ROW]);
    const { c } = mockContext({ is_active: false }, { id: "biz-1" });
    await updateBusiness(c as any, vi.fn() as any);
    expect(calls[0]!.params[0]).toBe(false);
  });

  it("404s a local the tenant does not own", async () => {
    mockDb(() => []);
    const { c } = mockContext({ name: "X" }, { id: "biz-other" });
    await expect(updateBusiness(c as any, vi.fn() as any)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("rejects an update with nothing to change", async () => {
    mockDb(() => []);
    const { c } = mockContext({}, { id: "biz-1" });
    await expect(updateBusiness(c as any, vi.fn() as any)).rejects.toBeInstanceOf(ValidationError);
  });

  it("rejects a wrong-typed is_active", async () => {
    mockDb(() => []);
    const { c } = mockContext({ is_active: "no" }, { id: "biz-1" });
    await expect(updateBusiness(c as any, vi.fn() as any)).rejects.toBeInstanceOf(ValidationError);
  });
});
