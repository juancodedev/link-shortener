import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock db/client
// ---------------------------------------------------------------------------

vi.mock("../../src/db/client", () => ({
  withClient: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock db/schema — use real functions for buildQuery (it's pure)
// ---------------------------------------------------------------------------

import { withClient } from "../../src/db/client";
import { provisionTenant } from "../../src/tenants/provision";

// ---------------------------------------------------------------------------
// Tenant provisioning tests (REQ-T002)
// ---------------------------------------------------------------------------

describe("provisionTenant", () => {
  const env = {
    SUPABASE_URL: "https://test.supabase.co",
    SUPABASE_ANON_KEY: "test-anon-key",
    SUPABASE_JWT_SECRET: "test-secret",
    SUPABASE_SERVICE_ROLE_KEY: "test-service-key",
    SHORT_URL_DOMAIN: "short.link",
  } as any;

  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("creates tenant, profile, schema, and executes DDL inside a real transaction", async () => {
    const executedQueries: string[] = [];

    vi.mocked(withClient).mockImplementation(async (_env: any, fn: any) => {
      return fn({
        query: vi.fn().mockImplementation((sql: string, params?: unknown[]) => {
          executedQueries.push(sql);

          if (sql.includes("INSERT INTO public.tenants")) {
            return Promise.resolve({ rows: [{ id: "new-tenant-uuid" }] });
          }
          if (sql.includes("INSERT INTO public.profiles")) {
            return Promise.resolve({ rows: [] });
          }
          if (sql.includes("CREATE SCHEMA")) {
            return Promise.resolve({ rows: [] });
          }
          // DDL statements
          return Promise.resolve({ rows: [] });
        }),
      });
    });

    const result = await provisionTenant(env, "user-123", "acme-corp", "Acme Corp");

    // Verify return value
    expect(result.tenantId).toBe("new-tenant-uuid");
    expect(result.schemaName).toMatch(/^tenant_[a-f0-9]{8}$/);

    // The transaction must be opened before any write and closed after the
    // last one. `withClient` alone does not give this — it only connects,
    // runs, and ends. Without explicit BEGIN/COMMIT a DDL failure mid-way
    // leaves a tenant row whose schema has no `links` table.
    expect(executedQueries[0]!.trim().toUpperCase()).toBe("BEGIN");
    expect(executedQueries[executedQueries.length - 1]!.trim().toUpperCase()).toBe("COMMIT");

    // Verify the real statements ran, in order, inside the transaction.
    // Ordered by position of first match, not by fixed index: the body gained a
    // statement when tenant_memberships was added, and a positional assertion
    // reports that as a failure instead of as the change it actually is.
    const body = executedQueries.slice(1, -1);
    const at = (needle: string) => body.findIndex((q) => q.includes(needle));
    const order = [
      at("INSERT INTO public.tenants"),
      at("INSERT INTO public.profiles"),
      at("INSERT INTO public.tenant_memberships"),
      at("CREATE SCHEMA"),
    ];
    for (const [i, idx] of order.entries()) {
      expect(idx, `${["tenants", "profiles", "memberships", "schema"][i]} statement missing`)
        .toBeGreaterThanOrEqual(0);
    }
    expect([...order].sort((a, b) => a - b)).toEqual(order);

    // DDL should include links table creation
    const ddlStatements = body.slice(at("CREATE SCHEMA") + 1);
    const allDdl = ddlStatements.join(" ");
    expect(allDdl).toContain("CREATE TABLE");
    expect(allDdl).toContain("links");
    expect(allDdl).toContain("_migrations");
  });

  it("rolls back and rethrows when a DDL statement fails", async () => {
    const executedQueries: string[] = [];

    vi.mocked(withClient).mockImplementation(async (_env: any, fn: any) => {
      return fn({
        query: vi.fn().mockImplementation((sql: string) => {
          executedQueries.push(sql);

          // Fail partway through the DDL, after the tenant row is written.
          if (sql.includes("CREATE TABLE") && sql.includes("links")) {
            return Promise.reject(new Error("ddl blew up"));
          }
          if (sql.includes("INSERT INTO public.tenants")) {
            return Promise.resolve({ rows: [{ id: "doomed-tenant-uuid", salt: "s" }] });
          }
          return Promise.resolve({ rows: [] });
        }),
      });
    });

    await expect(
      provisionTenant(env, "user-123", "doomed-co", "Doomed Co"),
    ).rejects.toThrow("ddl blew up");

    // The whole point: the tenant row written before the failure must be undone.
    expect(executedQueries[executedQueries.length - 1]!.trim().toUpperCase()).toBe("ROLLBACK");
    expect(executedQueries.join(" ")).not.toContain("COMMIT");
  });

  it("still attempts a ROLLBACK when the rollback itself fails", async () => {
    vi.mocked(withClient).mockImplementation(async (_env: any, fn: any) => {
      return fn({
        query: vi.fn().mockImplementation((sql: string) => {
          if (sql.trim().toUpperCase() === "ROLLBACK") {
            return Promise.reject(new Error("connection already gone"));
          }
          if (sql.includes("CREATE TABLE") && sql.includes("links")) {
            return Promise.reject(new Error("ddl blew up"));
          }
          if (sql.includes("INSERT INTO public.tenants")) {
            return Promise.resolve({ rows: [{ id: "doomed-tenant-uuid", salt: "s" }] });
          }
          return Promise.resolve({ rows: [] });
        }),
      });
    });

    // A dead connection means there is nothing left to roll back; the original
    // failure is what the caller needs to see, not the rollback's own error.
    await expect(
      provisionTenant(env, "user-123", "doomed-co", "Doomed Co"),
    ).rejects.toThrow("ddl blew up");
  });

  it("generates a schema name with tenant_ prefix and 8 hex chars", async () => {
    vi.mocked(withClient).mockImplementation(async (_env: any, fn: any) => {
      return fn({
        query: vi.fn().mockResolvedValue({ rows: [{ id: "uuid-1" }] }),
      });
    });

    const result = await provisionTenant(env, "user-456", "other-co", "Other Co");

    expect(result.schemaName).toMatch(/^tenant_[a-f0-9]{8}$/);
    expect(result.schemaName.length).toBe(15); // "tenant_" (7) + 8 hex = 15
  });

  it("inserts profile with role=owner", async () => {
    let profileSql: string | undefined;

    vi.mocked(withClient).mockImplementation(async (_env: any, fn: any) => {
      return fn({
        query: vi.fn().mockImplementation((sql: string, params?: unknown[]) => {
          if (sql.includes("INSERT INTO public.profiles")) {
            profileSql = sql;
          }
          return Promise.resolve({ rows: [{ id: "uuid-1" }] });
        }),
      });
    });

    await provisionTenant(env, "user-789", "test-co", "Test Co");

    // The role 'owner' is a SQL literal in the INSERT statement, not a parameter
    expect(profileSql).toBeDefined();
    expect(profileSql).toContain("'owner'");
  });

  it("executes all DDL statements from the template", async () => {
    const queryCalls: string[] = [];

    vi.mocked(withClient).mockImplementation(async (_env: any, fn: any) => {
      return fn({
        query: vi.fn().mockImplementation((sql: string) => {
          queryCalls.push(sql);
          return Promise.resolve({ rows: [{ id: "tenant-uuid" }] });
        }),
      });
    });

    await provisionTenant(env, "user-1", "ddl-co", "DDL Co");

    // Find DDL statements (after BEGIN, INSERT tenants, INSERT profiles, CREATE SCHEMA)
    const ddlCalls = queryCalls.filter(
      (sql) =>
        sql.includes("CREATE TABLE") ||
        sql.includes("CREATE INDEX") ||
        sql.includes("CREATE UNIQUE INDEX") ||
        sql.includes("INSERT INTO"),
    );

    // Should have at least: CREATE TABLE links, 3 indexes, CREATE TABLE _migrations, INSERT _migrations
    expect(ddlCalls.length).toBeGreaterThanOrEqual(6);

    expect(ddlCalls.some((c) => c.includes("CREATE TABLE") && c.includes("links"))).toBe(true);
    expect(ddlCalls.some((c) => c.includes("UNIQUE INDEX") && c.includes("short_code"))).toBe(true);
    expect(ddlCalls.some((c) => c.includes("_migrations"))).toBe(true);
  });

  it("uses one database connection for the whole provisioning run", async () => {
    vi.mocked(withClient).mockImplementation(async (_env: any, fn: any) => {
      return fn({
        query: vi.fn().mockResolvedValue({ rows: [{ id: "uuid-1" }] }),
      });
    });

    await provisionTenant(env, "user-x", "txn-co", "TXN Co");

    // One connection: the BEGIN ... COMMIT bracket has to hold a single
    // session, so splitting the work across two clients would silently
    // discard the transaction.
    expect(withClient).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Multi-site RBAC: the membership that makes a new tenant reachable
// ---------------------------------------------------------------------------

describe("provisionTenant — tenant_memberships", () => {
  const env = {
    SUPABASE_URL: "https://test.supabase.co",
    SUPABASE_ANON_KEY: "test-anon-key",
    SUPABASE_JWT_SECRET: "test-secret",
    SUPABASE_SERVICE_ROLE_KEY: "test-service-key",
    SHORT_URL_DOMAIN: "short.link",
  } as any;

  /** Captures every statement the provisioner runs. */
  function capture() {
    const queries: { sql: string; params?: unknown[] }[] = [];
    vi.mocked(withClient).mockImplementation(async (_env: any, fn: any) =>
      fn({
        query: vi.fn().mockImplementation((sql: string, params?: unknown[]) => {
          queries.push({ sql, params });
          if (sql.includes("INSERT INTO public.tenants")) {
            return Promise.resolve({ rows: [{ id: "tenant-1", salt: "salt-1" }] });
          }
          return Promise.resolve({ rows: [] });
        }),
      }),
    );
    return queries;
  }

  beforeEach(() => {
    vi.resetAllMocks();
  });

  // The cutover coupling. The resolver reads memberships; provision without
  // this write and a brand-new tenant exists, is active, and is invisible to
  // every /api/* route.
  it("creates the owner's membership alongside the profile", async () => {
    const queries = capture();

    await provisionTenant(env, "user-1", "mesa", "Mesa");

    const membership = queries.find((q) =>
      q.sql.includes("INSERT INTO public.tenant_memberships"),
    );
    expect(membership).toBeDefined();
    expect(membership!.params).toEqual(["user-1", "tenant-1", expect.any(String)]);
  });

  // 'owner' is not decorative: it is the role that grants management rights in
  // the new vocabulary.
  it("grants the membership role=owner", async () => {
    const queries = capture();

    await provisionTenant(env, "user-1", "mesa", "Mesa");

    const membership = queries.find((q) =>
      q.sql.includes("INSERT INTO public.tenant_memberships"),
    )!;
    expect(membership.sql).toContain("'owner'");
  });

  // Re-provisioning the same pairing must not fail on the UNIQUE constraint.
  it("is re-runnable against an existing membership", async () => {
    const queries = capture();

    await provisionTenant(env, "user-1", "mesa", "Mesa");

    const membership = queries.find((q) =>
      q.sql.includes("INSERT INTO public.tenant_memberships"),
    )!;
    expect(membership.sql).toContain("ON CONFLICT (profile_id, tenant_id) DO NOTHING");
  });

  // Both writes must be inside the transaction: a membership that commits
  // outside it survives a rollback of the tenant and points at nothing.
  it("writes the membership inside the same transaction as the tenant", async () => {
    const queries = capture();

    await provisionTenant(env, "user-1", "mesa", "Mesa");

    const begin = queries.findIndex((q) => /BEGIN/.test(q.sql));
    const commit = queries.findIndex((q) => /COMMIT/.test(q.sql));
    const membership = queries.findIndex((q) =>
      q.sql.includes("INSERT INTO public.tenant_memberships"),
    );
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(membership).toBeGreaterThan(begin);
    expect(membership).toBeLessThan(commit);
  });
});
