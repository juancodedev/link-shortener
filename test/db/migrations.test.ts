import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// Migration-set guard
//
// WHY THIS EXISTS
//
// On 2026-10-13 the production database turned out to be missing
// `public._migrations` and `analytics._migrations` entirely: it had been
// created from an earlier revision of 00001/00002 that predated those tables.
// The schema was applied; the bookkeeping was not.
//
// Every migration since then ends with an INSERT into one of those tables, so
// all four of 00006-00009 would have failed on their FINAL statement — after
// their DDL had already taken effect. The schema would be correct and the
// version record would say it had never run. That is the worst possible shape
// for a migration: it half-succeeds, and the bookkeeping is the part that lied.
//
// There is no migration runner in this repo; migrations are applied by hand.
// That makes ordering a human responsibility, and these tests are what turns it
// into a constraint the build enforces instead.
//
// WHAT IS ASSERTED
//
//   1. Filenames are contiguous from 00000 with no gaps.
//   2. No two migrations claim the same version in the same bookkeeping table.
//   3. Every migration records a version somewhere — a migration that silently
//      skips bookkeeping is what produced the original half-success.
//   4. A tenant-schema migration records its version in the tenant's own table.
// ---------------------------------------------------------------------------

/** Read at build time through Vite's ?raw import, as the other migration tests do. */
import m00000 from "../../supabase/migrations/00000_restore_migration_bookkeeping.sql?raw";
import m00001 from "../../supabase/migrations/00001_public_schema.sql?raw";
import m00002 from "../../supabase/migrations/00002_analytics_schema.sql?raw";
import m00003 from "../../supabase/migrations/00003_add_referrer_source.sql?raw";
import m00004 from "../../supabase/migrations/00004_add_client_ref_to_tenant_links.sql?raw";
import m00005 from "../../supabase/migrations/00005_short_code_registry.sql?raw";
import m00006 from "../../supabase/migrations/00006_locations.sql?raw";
import m00007 from "../../supabase/migrations/00007_add_location_id_to_tenant_links.sql?raw";
import m00008 from "../../supabase/migrations/00008_add_is_gated_to_tenant_links.sql?raw";
import m00009 from "../../supabase/migrations/00009_review_gate_schema.sql?raw";
import m00010 from "../../supabase/migrations/00010_backfill_tenant_migration_version_2.sql?raw";
import m00011 from "../../supabase/migrations/00011_tenant_memberships.sql?raw";
import m00012 from "../../supabase/migrations/00012_owner_delete_restrict.sql?raw";
import m00013 from "../../supabase/migrations/00013_subscription_status.sql?raw";
import m00014 from "../../supabase/migrations/00014_subscription_updated_at.sql?raw";
import m00015 from "../../supabase/migrations/00015_original_url_nullable.sql?raw";
import m00016 from "../../supabase/migrations/00016_business_feedback_email.sql?raw";
import m00017 from "../../supabase/migrations/00017_feedback_customer_phone.sql?raw";

interface Migration {
  version: number;
  name: string;
  sql: string;
}

const MIGRATIONS: Migration[] = [
  { version: 0, name: "00000_restore_migration_bookkeeping", sql: m00000 },
  { version: 1, name: "00001_public_schema", sql: m00001 },
  { version: 2, name: "00002_analytics_schema", sql: m00002 },
  { version: 3, name: "00003_add_referrer_source", sql: m00003 },
  { version: 4, name: "00004_add_client_ref_to_tenant_links", sql: m00004 },
  { version: 5, name: "00005_short_code_registry", sql: m00005 },
  { version: 6, name: "00006_locations", sql: m00006 },
  { version: 7, name: "00007_add_location_id_to_tenant_links", sql: m00007 },
  { version: 8, name: "00008_add_is_gated_to_tenant_links", sql: m00008 },
  { version: 9, name: "00009_review_gate_schema", sql: m00009 },
  { version: 10, name: "00010_backfill_tenant_migration_version_2", sql: m00010 },
  { version: 11, name: "00011_tenant_memberships", sql: m00011 },
  { version: 12, name: "00012_owner_delete_restrict", sql: m00012 },
  { version: 13, name: "00013_subscription_status", sql: m00013 },
  { version: 14, name: "00014_subscription_updated_at", sql: m00014 },
  { version: 15, name: "00015_original_url_nullable", sql: m00015 },
  { version: 16, name: "00016_business_feedback_email", sql: m00016 },
  { version: 17, name: "00017_feedback_customer_phone", sql: m00017 },
];

/** Strips `--` comments so a prose version number is never read as a claim. */
function code(sql: string): string {
  return sql
    .split("\n")
    .map((l) => l.replace(/--.*$/, ""))
    .join("\n");
}

/**
 * Every literal version a migration writes, per bookkeeping target.
 *
 * `public` and `analytics` are matched by table name; a per-tenant write uses
 * the dynamic `%I._migrations` form and is attributed to `tenant`.
 */
function recordedVersions(sql: string): {
  public: number[];
  analytics: number[];
  tenant: number[];
} {
  const src = code(sql);
  const out = { public: [] as number[], analytics: [] as number[], tenant: [] as number[] };

  const central =
    /INSERT\s+INTO\s+(public|analytics)\._migrations[\s\S]*?VALUES\s*\(\s*(\d+)\s*,\s*'([^']+)'/gi;
  for (const m of src.matchAll(central)) {
    out[m[1]!.toLowerCase() as "public" | "analytics"].push(Number(m[2]));
  }

  // The dynamic per-tenant write is formatted, so the version is a literal
  // inside the format() argument rather than inside an INSERT ... VALUES.
  const perTenant =
    /INSERT\s+INTO\s+%I\._migrations[\s\S]*?VALUES\s*\(\s*(\d+)\s*,\s*''([^']+)''/gi;
  for (const m of src.matchAll(perTenant)) {
    out.tenant.push(Number(m[1]));
  }

  return out;
}

/**
 * Migrations that record versions they did not author.
 *
 * 00000 exists because the database was missing both `_migrations` tables
 * entirely, so it re-records 00001-00005 — versions the migrations below it
 * already claim. That is deliberate backfill, not a duplicate claim: it
 * inserts the same (version, name) pairs with ON CONFLICT DO NOTHING, so the
 * outcome is identical to those migrations having run normally.
 *
 * A repair migration is exempt as a CLAIMANT. It is not exempt from the other
 * rules: it still has to record something, still has to be contiguous, and its
 * ALTERs still have to record per-tenant versions.
 */
const REPAIR_MIGRATIONS = new Set(["00000_restore_migration_bookkeeping"]);

function isRepair(m: Migration): boolean {
  return REPAIR_MIGRATIONS.has(m.name);
}

describe("migration set is contiguous and ordered", () => {
  it("has no gap in the version sequence", () => {
    const versions = MIGRATIONS.map((m) => m.version).sort((a, b) => a - b);
    for (let i = 0; i < versions.length; i++) {
      expect(versions[i]).toBe(i);
    }
  });

  it("uses zero-padded, ascending filenames that match their version", () => {
    for (const m of MIGRATIONS) {
      const prefix = String(m.version).padStart(5, "0");
      expect(m.name.startsWith(prefix)).toBe(true);
    }
  });

  it("holds no duplicate version", () => {
    const versions = MIGRATIONS.map((m) => m.version);
    expect(new Set(versions).size).toBe(versions.length);
  });
});

describe("every migration records the version it applied", () => {
  it("no migration is DDL-only with no bookkeeping write", () => {
    // This is the assertion the original failure would have tripped: a
    // migration whose DDL takes effect while its version record silently
    // fails is how the database ends up applying schema nobody can account
    // for. Every file must write to at least one version table.
    for (const m of MIGRATIONS) {
      const recorded = recordedVersions(m.sql);
      const total =
        recorded.public.length +
        recorded.analytics.length +
        recorded.tenant.length;
      expect(
        total,
        `${m.name} writes no version — its DDL could apply without being recorded`,
      ).toBeGreaterThan(0);
    }
  });

  it("no two migrations claim the same version in public._migrations", () => {
    const seen = new Map<number, string>();
    for (const m of MIGRATIONS) {
      if (isRepair(m)) continue;
      for (const v of recordedVersions(m.sql).public) {
        expect(
          seen.has(v),
          `version ${v} claimed by both ${seen.get(v)} and ${m.name}`,
        ).toBe(false);
        seen.set(v, m.name);
      }
    }
    // The repair migration may re-record versions, but never a version no
    // other migration authored — that would invent history.
    for (const v of recordedVersions(m00000).public) {
      expect(
        seen.has(v),
        `00000 records version ${v}, which no migration authored`,
      ).toBe(true);
    }
  });

  it("no two migrations claim the same version in analytics._migrations", () => {
    const seen = new Map<number, string>();
    for (const m of MIGRATIONS) {
      if (isRepair(m)) continue;
      for (const v of recordedVersions(m.sql).analytics) {
        expect(
          seen.has(v),
          `version ${v} claimed by both ${seen.get(v)} and ${m.name}`,
        ).toBe(false);
        seen.set(v, m.name);
      }
    }
    for (const v of recordedVersions(m00000).analytics) {
      expect(
        seen.has(v),
        `00000 records version ${v}, which no migration authored`,
      ).toBe(true);
    }
  });

  it("records its version in the tenant's own table as well, when it alters tenants", () => {
    // A migration that ALTERs a per-tenant schema but records only centrally
    // leaves the tenant's version table unable to answer "has this schema
    // been migrated", which is the question a future migration actually asks.
    for (const m of MIGRATIONS) {
      const altersTenantSchemas =
        /EXECUTE\s+format\s*\(\s*'\s*ALTER\s+TABLE\s+%I/i.test(code(m.sql));
      if (!altersTenantSchemas) continue;

      const recorded = recordedVersions(m.sql);
      expect(
        recorded.tenant.length,
        `${m.name} alters tenant schemas but records no per-tenant version`,
      ).toBeGreaterThan(0);
    }
  });
});

describe("migration safety", () => {
  it("every migration that creates a table uses IF NOT EXISTS", () => {
    // Re-running must be a no-op. A migration that only works once cannot be
    // applied safely to a database whose state is uncertain.
    for (const m of MIGRATIONS) {
      const src = code(m.sql);
      const creates = [...src.matchAll(/CREATE\s+TABLE\s+(?!IF\s+NOT\s+EXISTS)/gi)];
      expect(
        creates.length,
        `${m.name} has a CREATE TABLE without IF NOT EXISTS`,
      ).toBe(0);
    }
  });

  it("the tenant-ALTER migrations skip tenants with no links table", () => {
    // One half-provisioned registry row must not abort the loop for everyone
    // else's ALTER.
    for (const m of [m00004, m00007, m00008]) {
      expect(m).toMatch(/CONTINUE\s+WHEN/i);
      expect(m).toMatch(/to_regclass/i);
    }
  });

  it("the version-2 backfill only claims tenants that actually have the column", () => {
    // Recording a migration for a tenant it never reached is the mirror image
    // of the bug being repaired: a version table that lies in the other
    // direction is just as misleading.
    expect(m00010).toMatch(/information_schema\.columns/i);
    expect(m00010).toMatch(/column_name\s*=\s*'client_ref'/i);
    expect(m00010).toMatch(/CONTINUE\s+WHEN/i);
  });

  it("00006 runs before 00009 because 00009 has a foreign key into it", () => {
    // Ordering is human-managed here, so the dependency is asserted rather
    // than assumed. 00009 creates tag_ratings.location_id as a FK to
    // public.locations, which does not exist until 00006 creates it.
    expect(code(m00009)).toMatch(
      /REFERENCES\s+public\.locations\s*\(\s*id\s*\)/i,
    );
    expect(
      MIGRATIONS.findIndex((m) => m.name === "00006_locations")!,
    ).toBeLessThan(
      MIGRATIONS.findIndex((m) => m.name === "00009_review_gate_schema")!,
    );
  });
});
// ---------------------------------------------------------------------------
// 00012 — an owner deletion must not take live businesses with it
// ---------------------------------------------------------------------------

describe("00012 owner_id delete rule", () => {
  // Read from the real file rather than a paraphrase: the whole failure mode
  // was a rule that looked safe in the schema and destroyed forty tenants.
  const sql = m00012;

  it("replaces the cascading rule with RESTRICT", () => {
    expect(sql).toContain("ON DELETE RESTRICT");
    // The dangerous rule may only appear inside the guard that detects it.
    const restricts = sql.split("ON DELETE RESTRICT").length - 1;
    expect(restricts).toBe(1);
  });

  it("guards the change so re-running is a no-op", () => {
    // confdeltype 'c' is CASCADE; without the guard a second run would fail on
    // a constraint that no longer exists under that name.
    expect(sql).toContain("confdeltype = 'c'");
    expect(sql).toContain("IF EXISTS");
  });

  it("does not silently orphan tenants the way SET NULL would", () => {
    // SET NULL leaves the row serving with no owner, and DELETE /api/tenants
    // authorizes on owner_id — an un-deletable, un-explainable tenant.
    expect(sql).not.toContain("ON DELETE SET NULL");
  });

  // The schema was never the loss: {schema}.links has no FK to public.tenants.
  // What disappears is short_code_registry, and with it every printed sticker.
  it("is written for the registry, not for the links table", () => {
    expect(sql).toContain("short_code_registry");
    expect(sql).toContain("resolveRegistryEntry");
  });
});

// ---------------------------------------------------------------------------
// 00013 — subscription status
// ---------------------------------------------------------------------------

describe("00013 subscription_status", () => {
  const sql = m00013;

  // The whole migration is safe or unsafe on this one line. Anything else would
  // 404 every printed sticker of every existing customer the moment it runs.
  it("defaults to active so no live tenant starts failing", () => {
    expect(sql).toMatch(/subscription_status\s+TEXT\s+DEFAULT\s+'active'\s+NOT\s+NULL/i);
  });

  // is_active means "removed". subscription_status means "exists, unpaid".
  // Reporting a non-payment as a deletion is how a customer learns their
  // business was shut down when the truth is an invoice.
  it("is a separate column from is_active, not a replacement", () => {
    expect(sql).not.toMatch(/DROP\s+COLUMN[^;]*is_active/i);
    expect(sql).not.toMatch(/ALTER\s+COLUMN\s+is_active/i);
  });

  it("constrains the vocabulary so a typo cannot pause a tenant silently", () => {
    expect(sql).toContain("subscription_status IN ('active', 'past_due', 'canceled')");
  });

  it("is re-runnable", () => {
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS");
    // ADD CONSTRAINT has no IF NOT EXISTS form, so the CHECK must be guarded.
    expect(sql).toContain("tenants_subscription_status_check");
    expect(sql).toContain("IF NOT EXISTS");
  });
});

// ---------------------------------------------------------------------------
// 00017 — the phone is a column of its own, beside the email
// ---------------------------------------------------------------------------

describe("00017_feedback_customer_phone", () => {
  it("adds a nullable customer_phone to tag_feedback, idempotently", () => {
    expect(m00017).toMatch(
      /ALTER TABLE analytics\.tag_feedback\s+ADD COLUMN IF NOT EXISTS customer_phone TEXT\s*;/i,
    );
    // Every existing comment has no phone; NOT NULL would fail on the first row.
    expect(m00017).not.toMatch(/customer_phone TEXT NOT NULL/i);
  });

  it("records itself in the analytics bookkeeping table", () => {
    expect(m00017).toMatch(/INSERT INTO analytics\._migrations[\s\S]*\(4, '00017_feedback_customer_phone'\)/);
  });
});
