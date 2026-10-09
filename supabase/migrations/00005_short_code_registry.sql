-- Migration 00005: Global short-code registry
--
-- WHY: public short links are now flat — `https://<domain>/<code>` with no path
-- prefix. Previously the tenant slug sat in the path and DID the tenant
-- resolution (`GET /r/:tenant/:code`). With the slug gone, nothing maps a bare
-- short code back to a tenant, and the tenant schema name cannot be derived from
-- the URL at all.
--
-- So this table IS the resolution step: short_code → tenant_id → public.tenants
-- → schema_name. A redirect must read this table before it may touch any tenant
-- schema. It is not a cache and not a convenience index; it is the only thing
-- standing between an arbitrary path segment and a tenant schema.
--
-- NO BACKFILL. The database was emptied on 2026-10-09: public.tenants has 0
-- rows and no tenant schemas remain. The registry starts empty and is populated
-- from link creation forward. An earlier draft of the plan enumerated tenant
-- schemas to copy rows across — there is nothing to copy.
--
-- IDEMPOTENT BY CONSTRUCTION, matching 00001:
--   - CREATE TABLE / CREATE INDEX IF NOT EXISTS → re-running is a no-op
--   - the migration-tracking insert is ON CONFLICT DO NOTHING

-- short_code is globally unique, NOT (tenant_id, short_code).
--
-- This is the whole point of the table. The per-tenant `links.short_code` UNIQUE
-- constraint only guarantees uniqueness *within* a schema, so two tenants can
-- each hold a row for `abc1234`. Under the flat URL there is no slug to
-- disambiguate, so that state must be unrepresentable rather than merely
-- unlikely. The PRIMARY KEY is the arbiter: `src/api/links.ts` inserts the
-- registry row with ON CONFLICT DO NOTHING and retries the whole link creation
-- when the claim fails.
CREATE TABLE IF NOT EXISTS public.short_code_registry (
    short_code TEXT PRIMARY KEY,                              -- bare path segment, e.g. 'VHvuSpP'
    tenant_id  UUID NOT NULL
               REFERENCES public.tenants(id) ON DELETE CASCADE,  -- deprovisioning removes the codes
    link_id    UUID,                                          -- {tenant}.links.id; not FK (cross-schema)
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

-- Reverse lookup: cascade delete and per-tenant code enumeration scan by
-- tenant_id. Without this, ON DELETE CASCADE and the deprovision cleanup both
-- seq-scan the registry.
CREATE INDEX IF NOT EXISTS idx_short_code_registry_tenant
    ON public.short_code_registry(tenant_id);

-- RLS with NO policy for anon / authenticated.
--
-- This is the guard that makes a publishable-key client useless against this
-- table: with RLS enabled and zero permissive policies, every statement issued
-- as anon or authenticated matches no policy and reads/writes nothing. Without
-- the ENABLE alone it would be a no-op, so both halves are required.
--
-- The Worker is unaffected — it reaches Postgres through `pg`/Hyperdrive with a
-- service-role connection, which bypasses RLS.
--
-- NOTE: public.tenants (00001) is NOT RLS-enabled today, so this table is
-- currently stricter than the table it joins to. That asymmetry is deliberate:
-- the registry is the enumeration target (every tenant's short codes in one
-- query), whereas tenants is one row per customer. Tightening public.tenants is
-- a separate change and is not part of this migration.
ALTER TABLE public.short_code_registry ENABLE ROW LEVEL SECURITY;

-- Deliberately no CREATE POLICY statements. See above.

-- Record this migration centrally in the public schema.
-- 00001 recorded version 1 and 00004 recorded version 2; 3 is the next free
-- version in public._migrations.
INSERT INTO public._migrations (version, name)
VALUES (3, '00005_short_code_registry')
ON CONFLICT (version) DO NOTHING;
