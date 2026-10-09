-- Migration 00004: Add client_ref to every existing tenant's links table
--
-- Adds the user-defined CRM identifier to `links`. The canonical shape for a
-- freshly created tenant's links table is
-- supabase/migrations/tenant/001_create_links.sql, mirrored in the inline
-- template in src/tenants/provision.ts.
--
-- WHY THIS FILE EXISTS SEPARATELY:
-- Per-tenant schemas are NOT auto-migrated. `provision.ts` runs an inline DDL
-- template and nothing reads supabase/migrations/tenant/ at runtime, so the
-- only tenants that get a column from editing the template are those
-- provisioned AFTER the change. Every tenant already in production has its own
-- concrete schema and needs its own ALTER. That is exactly what bit us on
-- `referrer_source`.
--
-- HOW IT FINDS THE TARGETS:
-- Schema names are generated at provision time ("tenant_" + 8 hex chars), so
-- no migration can hardcode one. This enumerates public.tenants and runs the
-- statement per schema via format('%I', ...), which quotes the identifier.
--
-- IDEMPOTENT BY CONSTRUCTION:
--   - ADD COLUMN IF NOT EXISTS  → re-running is a no-op, not an error
--   - CREATE INDEX IF NOT EXISTS → ditto
--   - tenants whose links table is absent are skipped rather than aborting the
--     whole migration, so one malformed row cannot block everyone else's ALTER
--   - each tenant records version 2 in its own _migrations table

DO $$
DECLARE
    t RECORD;
BEGIN
    FOR t IN SELECT schema_name FROM public.tenants ORDER BY schema_name LOOP
        -- Skip any registry row whose links table does not exist, so a single
        -- inconsistent row cannot abort the loop for every other tenant.
        CONTINUE WHEN to_regclass(format('%I.links', t.schema_name)) IS NULL;

        -- Nullable: existing links keep working unchanged, no backfill needed
        EXECUTE format(
            'ALTER TABLE %I.links ADD COLUMN IF NOT EXISTS client_ref TEXT',
            t.schema_name
        );

        -- Same index the new-tenant DDL creates, so both paths converge
        EXECUTE format(
            'CREATE INDEX IF NOT EXISTS idx_links_client_ref ON %I.links(client_ref)',
            t.schema_name
        );

        -- Version 2 follows version 1 (001_create_links) in the tenant's own
        -- tracking table
        EXECUTE format(
            'INSERT INTO %I._migrations (version, name)
             VALUES (2, ''00004_add_client_ref_to_tenant_links'')
             ON CONFLICT (version) DO NOTHING',
            t.schema_name
        );
    END LOOP;
END $$;

-- Record this migration centrally in the public schema
INSERT INTO public._migrations (version, name)
VALUES (2, '00004_add_client_ref_to_tenant_links')
ON CONFLICT (version) DO NOTHING;
