-- Migration 00007: Add location_id to every existing tenant's links table
--
-- Attaches a link to one of its tenant's `public.locations`. A pack of five
-- stickers is five links, and this column is what tells the dashboard which
-- table, bar counter or till each one belongs to.
--
-- WHY THIS FILE EXISTS SEPARATELY FROM EDITING THE TEMPLATE:
-- Per-tenant schemas are NOT auto-migrated. `provision.ts` runs an inline DDL
-- template and nothing reads supabase/migrations/tenant/ at runtime, so editing
-- that template only affects tenants provisioned AFTER the change. Every tenant
-- already deployed has its own concrete schema and needs its own ALTER. This is
-- the same split `00004_add_client_ref_to_tenant_links.sql` established.
--
-- HOW IT FINDS THE TARGETS:
-- Schema names are generated at provision time ("tenant_" + 8 hex chars), so no
-- migration can hardcode one. This enumerates public.tenants and runs the
-- statement per schema via format('%I', ...), which quotes the identifier.
--
-- WHY NO FOREIGN KEY:
-- A constraint would guard nothing here. The links table lives in a tenant
-- schema that is dropped with the tenant, and public.locations cascades from the
-- same `public.tenants` row, so both objects always share a lifecycle. Meanwhile
-- `ALTER TABLE ... ADD CONSTRAINT` is not idempotent in PostgreSQL — there is no
-- IF NOT EXISTS form — which would break the re-runnable pattern above. Where
-- the constraint does earn its keep is Phase 2's `analytics.tag_ratings`, which
-- outlives any single tenant schema and therefore carries a real FK.
--
-- IDEMPOTENT BY CONSTRUCTION:
--   - ADD COLUMN IF NOT EXISTS → re-running is a no-op, not an error
--   - CREATE INDEX IF NOT EXISTS → ditto
--   - tenants whose links table is absent are skipped rather than aborting the
--     whole migration, so one malformed row cannot block everyone else's ALTER
--   - each tenant records version 3 in its own _migrations table
--
-- NULLABLE, NOT BACKFILLED: existing links keep a NULL location_id. That is the
-- truth — they were created before locations existed, and guessing one would
-- invent a grouping the owner never chose.

DO $$
DECLARE
    t RECORD;
BEGIN
    FOR t IN SELECT schema_name FROM public.tenants ORDER BY schema_name LOOP
        -- Skip any registry row whose links table does not exist, so a single
        -- inconsistent row cannot abort the loop for every other tenant.
        CONTINUE WHEN to_regclass(format('%I.links', t.schema_name)) IS NULL;

        -- Nullable: existing links stay exactly as they are.
        EXECUTE format(
            'ALTER TABLE %I.links ADD COLUMN IF NOT EXISTS location_id UUID',
            t.schema_name
        );

        -- Same index the new-tenant DDL creates, so both paths converge.
        -- Sparse: most links have no location until the owner assigns one.
        EXECUTE format(
            'CREATE INDEX IF NOT EXISTS idx_links_location ON %I.links(location_id)',
            t.schema_name
        );

        -- Version 3 follows 2 (00004) in the tenant's own tracking table.
        EXECUTE format(
            'INSERT INTO %I._migrations (version, name)
             VALUES (3, ''00007_add_location_id_to_tenant_links'')
             ON CONFLICT (version) DO NOTHING',
            t.schema_name
        );
    END LOOP;
END $$;

-- Record this migration centrally in the public schema
INSERT INTO public._migrations (version, name)
VALUES (5, '00007_add_location_id_to_tenant_links')
ON CONFLICT (version) DO NOTHING;