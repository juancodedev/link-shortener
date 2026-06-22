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

  it("creates tenant, profile, schema, and executes DDL in a transaction", async () => {
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

    // Verify transaction steps
    expect(executedQueries[0]).toContain("INSERT INTO public.tenants");
    expect(executedQueries[1]).toContain("INSERT INTO public.profiles");
    expect(executedQueries[2]).toContain("CREATE SCHEMA");

    // DDL should include links table creation
    const ddlStatements = executedQueries.slice(3);
    const allDdl = ddlStatements.join(" ");
    expect(allDdl).toContain("CREATE TABLE");
    expect(allDdl).toContain("links");
    expect(allDdl).toContain("_migrations");
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

    // Find DDL statements (after INSERT tenants, INSERT profiles, CREATE SCHEMA)
    const ddlCalls = queryCalls.slice(3);

    // Should have at least: CREATE TABLE links, 3 indexes, CREATE TABLE _migrations, INSERT _migrations
    expect(ddlCalls.length).toBeGreaterThanOrEqual(6);

    expect(ddlCalls.some((c) => c.includes("CREATE TABLE") && c.includes("links"))).toBe(true);
    expect(ddlCalls.some((c) => c.includes("UNIQUE INDEX") && c.includes("short_code"))).toBe(true);
    expect(ddlCalls.some((c) => c.includes("_migrations"))).toBe(true);
  });

  it("wraps all operations in a single transaction via withClient", async () => {
    let withClientCalled = false;

    vi.mocked(withClient).mockImplementation(async (_env: any, fn: any) => {
      withClientCalled = true;
      return fn({
        query: vi.fn().mockResolvedValue({ rows: [{ id: "uuid-1" }] }),
      });
    });

    await provisionTenant(env, "user-x", "txn-co", "TXN Co");

    expect(withClientCalled).toBe(true);
    // withClient should be called exactly once (all ops in one transaction)
    expect(withClient).toHaveBeenCalledTimes(1);
  });
});
