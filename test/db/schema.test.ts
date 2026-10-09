import { describe, it, expect } from "vitest";
import { validateSchemaName, qualifyTable, buildQuery } from "../../src/db/schema";

import referrerSourceMigration from "../../supabase/migrations/00003_add_referrer_source.sql?raw";

// ---------------------------------------------------------------------------
// validateSchemaName tests (REQ-R002)
// ---------------------------------------------------------------------------

describe("validateSchemaName", () => {
  describe("valid schema names", () => {
    it("accepts a standard pattern like tenant_a7f3", () => {
      expect(() => validateSchemaName("tenant_a7f3")).not.toThrow();
      expect(validateSchemaName("tenant_a7f3")).toBe("tenant_a7f3");
    });

    it("accepts short schema names like tenant_x", () => {
      expect(() => validateSchemaName("tenant_x")).not.toThrow();
      expect(validateSchemaName("tenant_x")).toBe("tenant_x");
    });

    it("accepts schema names with digits", () => {
      expect(() => validateSchemaName("tenant_123")).not.toThrow();
    });

    it("accepts schema names with underscores only", () => {
      expect(() => validateSchemaName("tenant_a_b_c")).not.toThrow();
    });
  });

  describe("SQL injection strings blocked", () => {
    it("rejects SQL injection: DROP TABLE", () => {
      expect(() => validateSchemaName("'; DROP TABLE--")).toThrow();
    });

    it("rejects SQL injection: SELECT", () => {
      expect(() => validateSchemaName("1; SELECT *")).toThrow();
    });

    it("rejects SQL injection: OR 1=1 with quotes", () => {
      expect(() => validateSchemaName('schema" OR 1=1--')).toThrow();
    });

    it("rejects SQL injection: UNION SELECT", () => {
      expect(() => validateSchemaName("x UNION SELECT")).toThrow();
    });

    it("rejects schema name with spaces", () => {
      expect(() => validateSchemaName("tenant a7f3")).toThrow();
    });

    it("rejects schema name with semicolons", () => {
      expect(() => validateSchemaName("tenant;a7f3")).toThrow();
    });
  });

  describe("empty and invalid patterns", () => {
    it("rejects an empty string", () => {
      expect(() => validateSchemaName("")).toThrow();
    });

    it("rejects a name starting with a number", () => {
      expect(() => validateSchemaName("1tenant")).toThrow();
    });

    it("rejects a name starting with an underscore", () => {
      expect(() => validateSchemaName("_tenant")).toThrow();
    });

    it("rejects a name with uppercase letters", () => {
      expect(() => validateSchemaName("Tenant_A7F3")).toThrow();
    });

    it("rejects a name with hyphens", () => {
      expect(() => validateSchemaName("tenant-a7f3")).toThrow();
    });

    it("rejects a name with special characters (dots)", () => {
      expect(() => validateSchemaName("tenant.a7f3")).toThrow();
    });
  });
});

// ---------------------------------------------------------------------------
// qualifyTable tests
// ---------------------------------------------------------------------------

describe("qualifyTable", () => {
  it("returns a double-quoted qualified table name", () => {
    const result = qualifyTable("tenant_a7f3", "links");
    expect(result).toBe('"tenant_a7f3"."links"');
  });

  it("handles different table names", () => {
    const result = qualifyTable("tenant_b12d", "_migrations");
    expect(result).toBe('"tenant_b12d"."_migrations"');
  });

  it("throws for invalid schema names", () => {
    expect(() => qualifyTable("'; DROP TABLE--", "links")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// buildQuery tests
// ---------------------------------------------------------------------------

describe("buildQuery", () => {
  it("replaces {schema} placeholder with validated, double-quoted schema name", () => {
    const result = buildQuery(
      "tenant_a7f3",
      "SELECT * FROM {schema}.links WHERE short_code = $1",
    );
    expect(result).toBe(
      'SELECT * FROM "tenant_a7f3".links WHERE short_code = $1',
    );
  });

  it("replaces multiple {schema} placeholders", () => {
    const result = buildQuery(
      "tenant_x",
      "CREATE TABLE {schema}.links (id UUID); CREATE INDEX ON {schema}.links(short_code)",
    );
    expect(result).toBe(
      'CREATE TABLE "tenant_x".links (id UUID); CREATE INDEX ON "tenant_x".links(short_code)',
    );
  });

  it("throws for invalid schema names", () => {
    expect(() =>
      buildQuery("1; DROP TABLE", "SELECT * FROM {schema}.links"),
    ).toThrow();
  });

  it("handles DDL templates with IF NOT EXISTS", () => {
    const result = buildQuery(
      "tenant_a7f3",
      "CREATE SCHEMA IF NOT EXISTS {schema}",
    );
    expect(result).toBe('CREATE SCHEMA IF NOT EXISTS "tenant_a7f3"');
  });
});

// ---------------------------------------------------------------------------
// Analytics migration tests
// ---------------------------------------------------------------------------

describe("00003_add_referrer_source migration", () => {
  it("adds referrer_source to analytics.link_clicks", () => {
    expect(referrerSourceMigration).toContain("referrer_source");
    expect(referrerSourceMigration).toMatch(
      /ALTER\s+TABLE\s+(IF\s+NOT\s+EXISTS\s+)?analytics\.link_clicks/i,
    );
    expect(referrerSourceMigration).toMatch(/ADD\s+COLUMN/i);
  });

  it("targets the shared analytics table, not a per-tenant schema", () => {
    // Per-tenant links tables are unrelated; referrer_source belongs only to
    // the shared click-tracking table written by the tracker.
    expect(referrerSourceMigration).not.toMatch(/tenant_\w+\.link_clicks/i);
    expect(referrerSourceMigration).toContain("analytics.link_clicks");
  });
});
