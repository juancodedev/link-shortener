-- Migration 00008: Add is_gated to every existing tenant's links table
--
-- The flag that makes a scan render the dual-path action screen instead of a
-- plain 302. Until it is true the link behaves exactly as it always has, so
-- this migration is a pure no-op on behaviour.
--
-- WHY THIS FILE EXISTS SEPARATELY FROM EDITING THE TEMPLATE:
-- Per-tenant schemas are NOT auto-migrated. `provision.ts` runs an inline DDL
-- template and nothing reads supabase/migrations/tenant/ at runtime, so editing
-- that template only affects tenants provisioned AFTER the change. Every tenant
-- already deployed has its own concrete schema and needs its own ALTER. Same
-- split as 00004 (client_ref) and 00007 (location_id).
--
-- WHY DEFAULT false MATTERS SO MUCH:
-- The backfill is the compatibility mechanism. Every row that already exists
-- reads false after this runs, so no deployed link changes what a scan shows.
-- A link only becomes gated when its owner explicitly turns it on. Had the
-- default been true, this migration would have silently replaced every live
-- redirect with an interstitial on the day it ran.
--
-- HOW IT FINDS THE TARGETS:
-- Schema names are generated at provision time ("tenant_" + 8 hex chars), so no
-- migration can hardcode one. This enumerates public.tenants and runs the
-- statement per schema via format('%I', ...), which quotes the identifier.
--
-- IDEMPOTENT BY CONSTRUCTION:
--   - ADD COLUMN IF NOT EXISTS → re-running is a no-op, not an error
--   - tenants whose links table is absent are skipped rather than aborting the
--     whole migration, so one malformed row cannot block everyone else's ALTER
--   - each tenant records version 4 in its own _migrations table
--
-- No index: is_gated is read for every scan that resolves a link, but the read
-- is on the row that is already being fetched for its URL. A partial index
-- would only help a query that filters on it, and no such query exists — the
-- dashboard filters by location, not by gating state.

DO $$
DECLARE
    t RECORD;
BEGIN
    FOR t IN SELECT schema_name FROM public.tenants ORDER BY schema_name LOOP
        -- Skip any registry row whose links table does not exist, so a single
        -- inconsistent row cannot abort the loop for every other tenant.
        CONTINUE WHEN to_regclass(format('%I.links', t.schema_name)) IS NULL;

        -- DEFAULT false is the compatibility guarantee: every existing row
        -- keeps the plain 302 behaviour it has today.
        EXECUTE format(
            'ALTER TABLE %I.links ADD COLUMN IF NOT EXISTS is_gated BOOLEAN DEFAULT false NOT NULL',
            t.schema_name
        );

        -- Version 4 follows 3 (00007) in the tenant's own tracking table.
        EXECUTE format(
            'INSERT INTO %I._migrations (version, name)
             VALUES (4, ''00008_add_is_gated_to_tenant_links'')
             ON CONFLICT (version) DO NOTHING',
            t.schema_name
        );
    END LOOP;
END $$;

-- Record this migration centrally in the public schema
INSERT INTO public._migrations (version, name)
VALUES (6, '00008_add_is_gated_to_tenant_links')
ON CONFLICT (version) DO NOTHING;