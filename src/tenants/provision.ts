import type { AppEnv } from "../types/env";
import { withClient } from "../db/client";
import { buildQuery } from "../db/schema";

// ---------------------------------------------------------------------------
// Tenant DDL template — inline because Workers cannot read files at runtime
// ---------------------------------------------------------------------------

/**
 * Per-tenant schema DDL template.
 *
 * `{schema}` placeholders are replaced at runtime with the validated,
 * double-quoted schema name via `buildQuery()`.
 *
 * This DDL must match `supabase/migrations/tenant/001_create_links.sql`.
 * When the migration file changes, update this constant.
 */
const TENANT_DDL = `
CREATE TABLE IF NOT EXISTS {schema}.links (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  original_url TEXT NOT NULL,
  short_code TEXT NOT NULL,
  title TEXT,
  clicks_count INTEGER DEFAULT 0 NOT NULL,
  is_active BOOLEAN DEFAULT true NOT NULL,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_links_short_code
  ON {schema}.links(short_code);
CREATE INDEX IF NOT EXISTS idx_links_created_at
  ON {schema}.links(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_links_active_expires
  ON {schema}.links(is_active, expires_at) WHERE is_active = true;
CREATE TABLE IF NOT EXISTS {schema}._migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);
INSERT INTO {schema}._migrations (version, name)
VALUES (1, '001_create_links')
ON CONFLICT (version) DO NOTHING;
`;

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export interface ProvisionResult {
  schemaName: string;
  tenantId: string;
  tenantSalt: string;
}

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

/**
 * Provisions a new tenant: inserts registry rows, creates a dedicated
 * PostgreSQL schema, runs DDL to create the `links` table plus indexes,
 * and records the migration version.
 *
 * All DB operations run in a single transaction via `withClient`. Any
 * failure causes a full rollback (client throws → connection ends →
 * uncommitted work is discarded).
 *
 * After the transaction commits, the KV cache is warmed asynchronously
 * via the caller's ctx.waitUntil (handled in the API endpoint).
 *
 * @param env      - Worker environment (bindings)
 * @param userId   - UUID of the owner (from Supabase Auth)
 * @param subdomain - Tenant subdomain slug (already validated)
 * @param displayName - Human-readable tenant name
 * @returns The generated schema name and new tenant UUID
 */
export async function provisionTenant(
  env: AppEnv,
  userId: string,
  subdomain: string,
  displayName: string,
): Promise<ProvisionResult> {
  // Generate unique schema name: "tenant_" + first 8 chars of a random UUID
  const schemaSuffix = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  const schemaName = `tenant_${schemaSuffix}`;
  const now = new Date().toISOString();

  return withClient(env, async (client) => {
    // --- 1. INSERT into public.tenants ---
    const tenantRes = await client.query<{ id: string; salt: string }>(
      `INSERT INTO public.tenants (schema_name, display_name, subdomain, owner_id, is_active, created_at)
       VALUES ($1, $2, $3, $4, true, $5)
       RETURNING id, salt`,
      [schemaName, displayName, subdomain, userId, now],
    );
    const tenantId = tenantRes.rows[0]!.id;
    const tenantSalt = tenantRes.rows[0]!.salt;

    // --- 2. INSERT into public.profiles ---
    await client.query(
      `INSERT INTO public.profiles (id, tenant_id, role, created_at)
       VALUES ($1, $2, 'owner', $3)`,
      [userId, tenantId, now],
    );

    // --- 3. CREATE SCHEMA ---
    await client.query(buildQuery(schemaName, `CREATE SCHEMA IF NOT EXISTS {schema}`));

    // --- 4. Execute tenant DDL (links table + indexes + _migrations) ---
    // Split by semicolons and execute each statement individually.
    // pg's `query()` only supports a single SQL statement per call.
    const ddl = buildQuery(schemaName, TENANT_DDL);
    const statements = ddl
      .split(";")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    for (const stmt of statements) {
      await client.query(stmt + ";");
    }

    return { schemaName, tenantId, tenantSalt };
  });
}
