import { describe, it, expect } from "vitest";
import { validateSchemaName, qualifyTable, buildQuery } from "../../src/db/schema";

import referrerSourceMigration from "../../supabase/migrations/00003_add_referrer_source.sql?raw";
import tenantLinksMigration from "../../supabase/migrations/tenant/001_create_links.sql?raw";
import clientRefAlterMigration from "../../supabase/migrations/00004_add_client_ref_to_tenant_links.sql?raw";
import locationsMigration from "../../supabase/migrations/00006_locations.sql?raw";
import locationIdAlterMigration from "../../supabase/migrations/00007_add_location_id_to_tenant_links.sql?raw";
import { TENANT_DDL } from "../../src/tenants/provision";

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

// ---------------------------------------------------------------------------
// tenant/001_create_links template — client_ref (T1.1)
// ---------------------------------------------------------------------------

describe("tenant 001_create_links template", () => {
  it("declares client_ref on the links table", () => {
    expect(tenantLinksMigration).toMatch(/client_ref\s+TEXT/i);
  });

  it("keeps client_ref nullable so existing links need no backfill", () => {
    const columnLine = tenantLinksMigration
      .split("\n")
      .find((l) => /client_ref/i.test(l))!;
    expect(columnLine).toBeTruthy();
    // No NOT NULL and no non-null DEFAULT on the column definition
    expect(columnLine).not.toMatch(/NOT\s+NULL/i);
  });

  it("indexes client_ref so per-client rollups stay cheap (T2.3)", () => {
    expect(tenantLinksMigration).toMatch(
      /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+idx_links_client_ref[\s\S]*?links\s*\(\s*client_ref\s*\)/i,
    );
  });
});

// ---------------------------------------------------------------------------
// 00004_add_client_ref_to_tenant_links — existing-tenant ALTER (T1.3)
// ---------------------------------------------------------------------------

describe("00004_add_client_ref_to_tenant_links migration", () => {
  it("adds client_ref via ALTER TABLE rather than editing the create template", () => {
    // Editing 001_create_links.sql only affects tenants provisioned AFTER the
    // change. Every already-deployed tenant needs its own ALTER.
    expect(clientRefAlterMigration).toMatch(/ALTER\s+TABLE/i);
    expect(clientRefAlterMigration).toMatch(/ADD\s+COLUMN/i);
    expect(clientRefAlterMigration).toMatch(/client_ref\s+TEXT/i);
  });

  it("is idempotent so re-running is safe", () => {
    expect(clientRefAlterMigration).toMatch(/ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS/i);
    expect(clientRefAlterMigration).toMatch(/IF\s+NOT\s+EXISTS/i);
  });

  it("discovers concrete schema names from the tenant registry", () => {
    // Per-tenant schemas are named at provision time ("tenant_" + 8 hex chars),
    // so no migration can hardcode one. It must enumerate public.tenants.
    expect(clientRefAlterMigration).toMatch(/public\.tenants/i);
    expect(clientRefAlterMigration).toMatch(/schema_name/i);
    // ...and run as dynamic SQL against each name it finds
    expect(clientRefAlterMigration).toMatch(/EXECUTE\s+format/i);
  });

  it("records its version in each tenant's own _migrations table", () => {
    expect(clientRefAlterMigration).toMatch(/_migrations/i);
    expect(clientRefAlterMigration).toContain("00004_add_client_ref_to_tenant_links");
  });
});

// ---------------------------------------------------------------------------
// Dual-DDL parity guard: provision.ts template vs tenant/001_create_links.sql
// ---------------------------------------------------------------------------

/**
 * The `links` DDL is maintained in two places by hand — the SQL migration file
 * and the inline template `provision.ts` runs (Workers cannot read files at
 * runtime). Drift here is silent: one path provisions new tenants with a schema
 * the other path's tests assume. These helpers compare the COLUMN NAMES only,
 * ignoring the whitespace and comment differences that already exist between
 * the two copies.
 *
 * Comments are stripped BEFORE the block is located, not after. Slicing on
 * `indexOf(");")` over raw text breaks the moment a comment mentions a
 * parenthesised expression — a `public.locations(id);` in a column comment
 * truncated the block and made this guard compare a 10-column list against a
 * 5-column one. The guard silently defeated itself, which is the one failure
 * mode it exists to prevent.
 */
function linkColumnNames(ddl: string): string[] {
  const code = stripSqlComments(ddl);
  const body = code.slice(code.indexOf("CREATE TABLE"), code.indexOf(");"));
  return body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^(CREATE\s+TABLE|IF\s+NOT\s+EXISTS|\{schema\})/i.test(line))
    .map((line) => line.split(/\s+/)[0]!.toLowerCase())
    .sort();
}

/** Removes `--` line comments, which carry prose, not DDL. */
function stripSqlComments(ddl: string): string {
  return ddl
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
}

describe("provision.ts template / tenant 001_create_links parity", () => {
  it("declares an identical set of links columns in both copies", () => {
    expect(linkColumnNames(TENANT_DDL)).toEqual(linkColumnNames(tenantLinksMigration));
  });

  it("declares the same indexes in both copies", () => {
    const indexNames = (ddl: string) =>
      [...stripSqlComments(ddl).matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS\s+(\w+)/gi)].map((m) =>
        m[1]!.toLowerCase(),
      );
    expect(indexNames(TENANT_DDL).sort()).toEqual(indexNames(tenantLinksMigration).sort());
  });

  it("carries client_ref through both copies", () => {
    expect(TENANT_DDL).toMatch(/client_ref\s+TEXT/i);
    expect(TENANT_DDL).toMatch(/idx_links_client_ref/i);
  });

  // -------------------------------------------------------------------------
  // location_id (T1.3)
  // -------------------------------------------------------------------------

  it("declares location_id in both copies", () => {
    expect(TENANT_DDL).toMatch(/location_id\s+UUID/i);
    expect(tenantLinksMigration).toMatch(/location_id\s+UUID/i);
  });

  it("keeps location_id nullable in both copies so existing links need no backfill", () => {
    for (const ddl of [TENANT_DDL, tenantLinksMigration]) {
      const columnLine = ddl.split("\n").find((l) => /^\s*location_id\b/i.test(l))!;
      expect(columnLine).toBeTruthy();
      expect(columnLine).not.toMatch(/NOT\s+NULL/i);
      // A non-null DEFAULT would defeat "existing rows stay NULL".
      expect(columnLine).not.toMatch(/DEFAULT/i);
    }
  });

  it("does not put a foreign key on links.location_id", () => {
    // Deliberate. Links live in a tenant schema that is dropped with the
    // tenant, and public.locations cascades with the same tenant, so a
    // constraint guards nothing CASCADE does not already handle — while
    // ADD CONSTRAINT is not idempotent in PostgreSQL, which would break the
    // re-runnable ALTER pattern the 00004 migration established.
    expect(TENANT_DDL).not.toMatch(/location_id[^,]*REFERENCES/i);
    expect(tenantLinksMigration).not.toMatch(/location_id[^,]*REFERENCES/i);
  });

  it("indexes location_id in both copies so per-location rollups stay cheap", () => {
    for (const ddl of [TENANT_DDL, tenantLinksMigration]) {
      expect(ddl).toMatch(
        /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+idx_links_location[\s\S]*?links\s*\(\s*location_id\s*\)/i,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 00006_locations — the per-business locations table (T1.1, T1.2)
// ---------------------------------------------------------------------------

describe("00006_locations migration", () => {
  it("creates public.locations", () => {
    expect(locationsMigration).toMatch(
      /CREATE\s+TABLE\s+(IF\s+NOT\s+EXISTS\s+)?public\.locations/i,
    );
  });

  it("scopes a location to its tenant via a cascading foreign key", () => {
    expect(locationsMigration).toMatch(
      /tenant_id\s+UUID[^,]*REFERENCES\s+public\.tenants\s*\(\s*id\s*\)\s*ON\s+DELETE\s+CASCADE/i,
    );
  });

  it("indexes tenant_id so per-tenant lookups do not scan", () => {
    expect(locationsMigration).toMatch(
      /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+idx_locations_tenant[\s\S]*?locations\s*\(\s*tenant_id\s*\)/i,
    );
  });

  it("makes slug unique per tenant so two sites can share a display name", () => {
    expect(locationsMigration).toMatch(
      /CREATE\s+UNIQUE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+\w+\s+ON\s+public\.locations\s*\(\s*tenant_id\s*,\s*slug\s*\)/i,
    );
  });

  it("backfills one location per existing tenant", () => {
    // Without this, every tenant created before the change would have zero
    // locations and Phase 2 could not attach a rating to any of its links.
    expect(locationsMigration).toMatch(
      /INSERT\s+INTO\s+public\.locations[\s\S]*?SELECT[\s\S]*?FROM\s+public\.tenants/i,
    );
    expect(locationsMigration).toMatch(/ON\s+CONFLICT/i);
  });

  it("is idempotent throughout", () => {
    expect(locationsMigration).toMatch(/IF\s+NOT\s+EXISTS/i);
    expect(locationsMigration).toMatch(/ON\s+CONFLICT/i);
  });

  it("records its version in public._migrations", () => {
    expect(locationsMigration).toMatch(/public\._migrations/i);
    expect(locationsMigration).toContain("00006_locations");
  });
});

// ---------------------------------------------------------------------------
// 00007_add_location_id_to_tenant_links — existing-tenant ALTER (T1.3)
// ---------------------------------------------------------------------------

describe("00007_add_location_id_to_tenant_links migration", () => {
  it("alters existing tenant schemas rather than editing the create template", () => {
    expect(locationIdAlterMigration).toMatch(/ALTER\s+TABLE/i);
    expect(locationIdAlterMigration).toMatch(/ADD\s+COLUMN/i);
    expect(locationIdAlterMigration).toMatch(/location_id\s+UUID/i);
  });

  it("is idempotent so re-running is safe", () => {
    expect(locationIdAlterMigration).toMatch(/ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS/i);
  });

  it("discovers concrete schema names from the tenant registry", () => {
    expect(locationIdAlterMigration).toMatch(/public\.tenants/i);
    expect(locationIdAlterMigration).toMatch(/schema_name/i);
    expect(locationIdAlterMigration).toMatch(/EXECUTE\s+format/i);
  });

  it("skips tenants whose links table is absent instead of aborting the loop", () => {
    expect(locationIdAlterMigration).toMatch(/CONTINUE\s+WHEN/i);
    expect(locationIdAlterMigration).toMatch(/to_regclass/i);
  });

  it("records its version in each tenant's own _migrations table", () => {
    expect(locationIdAlterMigration).toMatch(/_migrations/i);
    expect(locationIdAlterMigration).toContain("00007_add_location_id_to_tenant_links");
  });
});
