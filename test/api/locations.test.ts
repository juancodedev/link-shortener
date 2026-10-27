import { describe, it, expect, beforeEach, vi } from "vitest";
import { listLocations, createLocation, updateLocation } from "../../src/api/locations";
import { withClient } from "../../src/db/client";
import { ValidationError, NotFoundError } from "../../src/middleware/error";

// ---------------------------------------------------------------------------
// Locations API
//
// The table shipped in 00006, links gained a `location_id` in 00007, PR #62 made
// it settable and PR #63 made a scan carry it through to the rollup. Every half
// of the measurement path existed and none of it was reachable without running
// SQL in the Supabase console — which is the wrong shape for a product whose
// customer is a business owner.
//
// These tests are written to fail if the tenant filter is ever dropped: every
// query filters on `tenant_id`, and "a valid uuid is not yours" is the property
// that keeps one business out of another's table list.
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
      get: vi.fn().mockImplementation((k: string) =>
        k === "tenant" ? TENANT : undefined,
      ),
    },
    jsonFn,
  };
}

/** Routes by SQL shape rather than call order. */
function mockDb(handlers: (sql: string, params: unknown[]) => unknown) {
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

const LOCATION_ROW = {
  id: "loc-1",
  name: "Mesa 1",
  slug: "mesa-1",
  is_active: true,
  created_at: "2026-01-01T00:00:00Z",
};

describe("GET /api/locations", () => {
  beforeEach(() => vi.clearAllMocks());

  it("lists the tenant's locations with a link count each", async () => {
    mockDb(() => [{ ...LOCATION_ROW, link_count: "3" }]);

    const { c, jsonFn } = mockContext();
    await listLocations(c as any);

    const body = jsonFn.mock.calls[0]![0] as any;
    expect(body.locations).toHaveLength(1);
    expect(body.locations[0].name).toBe("Mesa 1");
  });

  it("reports the link count as a number, not Postgres's string", async () => {
    mockDb(() => [{ ...LOCATION_ROW, link_count: "12" }]);

    const { c, jsonFn } = mockContext();
    await listLocations(c as any);

    // A JSON string here renders as "12" in the dashboard's copy and reads as
    // a defect to the owner looking at their own table.
    const body = jsonFn.mock.calls[0]![0] as any;
    expect(body.locations[0].link_count).toBe(12);
  });

  it("counts against the TENANT schema, not a shared one", async () => {
    const calls = mockDb(() => [{ ...LOCATION_ROW, link_count: "0" }]);

    const { c } = mockContext();
    await listLocations(c as any);

    // The links table is per-tenant. An unqualified name would either throw or
    // resolve to a schema that happens to exist.
    expect(calls[0].sql).toContain('"tenant_a7f3"."links"');
  });

  it("filters by tenant, so one business never lists another's tables", async () => {
    const calls = mockDb(() => [{ ...LOCATION_ROW, link_count: "0" }]);

    const { c } = mockContext();
    await listLocations(c as any);

    expect(calls[0].sql).toContain("l.tenant_id = $1");
    expect(calls[0].params).toContain("tenant-uuid");
  });

  it("shows a location with no links rather than hiding it", async () => {
    mockDb(() => [{ ...LOCATION_ROW, link_count: "0" }]);

    const { c, jsonFn } = mockContext();
    await listLocations(c as any);

    // A newly created table that does not appear looks like it was not created.
    const body = jsonFn.mock.calls[0]![0] as any;
    expect(body.locations[0].link_count).toBe(0);
  });

  it("returns an empty list for a tenant that has none", async () => {
    mockDb(() => []);

    const { c, jsonFn } = mockContext();
    await listLocations(c as any);

    expect(jsonFn.mock.calls[0]![0]).toEqual({ locations: [] });
  });
});

describe("POST /api/locations", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates a location and returns it", async () => {
    mockDb(() => [LOCATION_ROW]);

    const { c, jsonFn } = mockContext({ name: "Mesa 1", slug: "mesa-1" });
    await createLocation(c as any);

    expect(jsonFn.mock.calls[0]![1]).toBe(201);
    const body = jsonFn.mock.calls[0]![0] as any;
    expect(body.location.name).toBe("Mesa 1");
  });

  it("derives the slug from the name when none is given", async () => {
    const calls = mockDb(() => [LOCATION_ROW]);

    const { c } = mockContext({ name: "Mesa 1" });
    await createLocation(c as any);

    // "Mesa 1" should not also mean typing mesa-1 by hand.
    expect(calls[0].params).toContain("mesa-1");
  });

  it("folds accents instead of dropping them", async () => {
    const calls = mockDb(() => [LOCATION_ROW]);

    const { c } = mockContext({ name: "Mesa Ñoqui" });
    await createLocation(c as any);

    // Dropping the accent outright would yield mesa-ooqui, a slug that means
    // something different from the name the owner can see.
    expect(calls[0].params).toContain("mesa-noqui");
  });

  it("reports a duplicate slug as a 409 rather than suffixing it", async () => {
    mockDb(() => {
      const e = new Error(
        'duplicate key value violates unique constraint "idx_locations_tenant_slug"',
      );
      throw e;
    });

    const { c } = mockContext({ name: "Mesa 1", slug: "mesa-1" });

    // mesa-1 and mesa-1-2 are indistinguishable to the owner choosing between
    // them months later, so the collision is reported, not papered over.
    await expect(createLocation(c as any)).rejects.toThrow(/already exists/i);
  });

  it("rejects an empty name", async () => {
    const { c } = mockContext({ name: "   " });
    await expect(createLocation(c as any)).rejects.toThrow(ValidationError);
  });

  it("rejects a name over the limit rather than truncating it", async () => {
    const { c } = mockContext({ name: "x".repeat(200) });
    await expect(createLocation(c as any)).rejects.toThrow(ValidationError);
  });

  it("rejects an explicitly supplied slug the database would refuse", async () => {
    const { c } = mockContext({ name: "Mesa 1", slug: "Mesa 1!" });

    // The caller learns from a 400, not from a constraint violation.
    await expect(createLocation(c as any)).rejects.toThrow(/slug must be/i);
  });

  it("rejects a non-string name", async () => {
    const { c } = mockContext({ name: { id: 1 } });
    await expect(createLocation(c as any)).rejects.toThrow(ValidationError);
  });

  it("never writes a slug that is not the tenant's own", async () => {
    const calls = mockDb(() => [LOCATION_ROW]);

    const { c } = mockContext({ name: "Mesa 1" });
    await createLocation(c as any);

    expect(calls[0].params).toContain("tenant-uuid");
  });
});

describe("PATCH /api/locations/:id", () => {
  beforeEach(() => vi.clearAllMocks());

  it("renames a location", async () => {
    const calls = mockDb(() => [{ ...LOCATION_ROW, name: "Mesa 2" }]);

    const { c, jsonFn } = mockContext({ name: "Mesa 2" }, { id: "loc-1" });
    await updateLocation(c as any);

    expect(calls[0].params).toContain("Mesa 2");
    expect(jsonFn).toHaveBeenCalledWith({ ok: true });
  });

  it("switches a location off", async () => {
    const calls = mockDb(() => [LOCATION_ROW]);

    const { c } = mockContext({ is_active: false }, { id: "loc-1" });
    await updateLocation(c as any);

    expect(calls[0].params).toContain(false);
  });

  it("REJECTS a slug change: it appears on printed material", async () => {
    const calls = mockDb(() => [LOCATION_ROW]);

    const { c } = mockContext({ slug: "mesa-nueva" }, { id: "loc-1" });

    // Rejected rather than ignored: a silently-dropped rename returns ok:true
    // and leaves the caller believing it landed, while whatever the designer
    // already printed still says the old slug.
    //
    // Asserted on the CODE, not just the error type. Allowing the rename would
    // leave the body with nothing else to set, so the handler would fail with
    // "No fields to update" — also a ValidationError, and a test asserting only
    // the type would pass against the exact defect it exists to catch.
    await expect(updateLocation(c as any)).rejects.toMatchObject({
      code: "slug_immutable",
    });
    expect(withClient).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it("scopes the UPDATE by tenant, not by id alone", async () => {
    const calls = mockDb(() => [LOCATION_ROW]);

    const { c } = mockContext({ name: "Mesa 2" }, { id: "loc-1" });
    await updateLocation(c as any);

    // Owning the id must not be sufficient to write a row that belongs
    // elsewhere.
    expect(calls[0].sql).toContain("tenant_id = $");
    expect(calls[0].params).toContain("tenant-uuid");
  });

  it("404s a location the tenant does not own", async () => {
    mockDb(() => []);

    const { c } = mockContext({ name: "Mesa 2" }, { id: "loc-other" });
    await expect(updateLocation(c as any)).rejects.toThrow(NotFoundError);
  });

  it("rejects an update with nothing to change", async () => {
    const { c } = mockContext({}, { id: "loc-1" });
    await expect(updateLocation(c as any)).rejects.toThrow(/No fields/i);
  });

  it("rejects a wrong-typed is_active", async () => {
    const { c } = mockContext({ is_active: "no" }, { id: "loc-1" });
    await expect(updateLocation(c as any)).rejects.toThrow(ValidationError);
  });
});

// ---------------------------------------------------------------------------
// A location is a branch (sucursal) of a business (local).
// odd/tasks/business-branches.md, S1-S2.
// ---------------------------------------------------------------------------

describe("locations belong to a business", () => {
  beforeEach(() => vi.clearAllMocks());

  it("lists each location with its business id and name", async () => {
    const calls = mockDb(() => [
      { ...LOCATION_ROW, link_count: "1", business_id: "biz-1", business_name: "Café Central" },
      { ...LOCATION_ROW, id: "loc-2", link_count: "0", business_id: null, business_name: null },
    ]);

    const { c, jsonFn } = mockContext();
    await listLocations(c as any);

    // LEFT JOIN: a branch with no local must still be listed.
    expect(calls[0]!.sql).toMatch(/LEFT JOIN public\.businesses b ON b\.id = l\.business_id/);
    const body = jsonFn.mock.calls[0]![0] as any;
    expect(body.locations[0]).toMatchObject({ business_id: "biz-1", business_name: "Café Central" });
    expect(body.locations[1]).toMatchObject({ business_id: null, business_name: null });
  });

  it("creates a branch inside a business the tenant owns", async () => {
    const calls = mockDb((sql) =>
      sql.includes("FROM public.businesses") ? [{ id: "biz-1" }] : [{ ...LOCATION_ROW, business_id: "biz-1" }],
    );

    const { c, jsonFn } = mockContext({ name: "Mesa 1", business_id: "11111111-1111-4111-8111-111111111111" });
    await createLocation(c as any);

    const check = calls.find((q) => q.sql.includes("FROM public.businesses"))!;
    expect(check.sql).toContain("tenant_id = $2");
    expect(check.params).toEqual(["11111111-1111-4111-8111-111111111111", "tenant-uuid"]);
    const insert = calls.find((q) => q.sql.includes("INSERT INTO public.locations"))!;
    expect(insert.sql).toMatch(/\(tenant_id, name, slug, business_id\)/);
    expect(insert.params).toContain("11111111-1111-4111-8111-111111111111");
    expect((jsonFn.mock.calls[0]![0] as any).location.business_id).toBe("biz-1");
  });

  it("refuses a business that belongs to another tenant, without inserting", async () => {
    const calls = mockDb((sql) => (sql.includes("FROM public.businesses") ? [] : [LOCATION_ROW]));

    const { c } = mockContext({ name: "Mesa 1", business_id: "22222222-2222-4222-8222-222222222222" });
    await expect(createLocation(c as any)).rejects.toMatchObject({ code: "invalid_business_id" });
    expect(calls.find((q) => q.sql.includes("INSERT"))).toBeUndefined();
  });

  it("rejects a business_id that is not a uuid before touching the database", async () => {
    const calls = mockDb(() => []);
    const { c } = mockContext({ name: "Mesa 1", business_id: "nope" });
    await expect(createLocation(c as any)).rejects.toMatchObject({ code: "invalid_business_id" });
    expect(calls).toHaveLength(0);
  });

  it("still creates a branch with no business, as before", async () => {
    const calls = mockDb(() => [LOCATION_ROW]);
    const { c } = mockContext({ name: "Mesa 1" });
    await createLocation(c as any);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.params).toContain(null);
  });

  it("moves a branch to another business, or detaches it with null", async () => {
    const calls = mockDb((sql) => (sql.includes("FROM public.businesses") ? [{ id: "biz-2" }] : [LOCATION_ROW]));
    const { c } = mockContext({ business_id: "33333333-3333-4333-8333-333333333333" }, { id: "loc-1" });
    await updateLocation(c as any);
    const update = calls.find((q) => q.sql.includes("UPDATE public.locations"))!;
    expect(update.sql).toMatch(/business_id = \$1/);
    expect(update.params[0]).toBe("33333333-3333-4333-8333-333333333333");

    const calls2 = mockDb(() => [LOCATION_ROW]);
    const second = mockContext({ business_id: null }, { id: "loc-1" });
    await updateLocation(second.c as any);
    expect(calls2).toHaveLength(1);
    expect(calls2[0]!.params[0]).toBeNull();
  });
});
