-- Migration 00015: make original_url nullable on every existing tenant's links table
--
-- Lets an owner manufacture card stock before its destination exists: a batch
-- of links carrying no destination, each printed as a QR, loaded with the real
-- URL later. The row is ACTIVE from creation, so a NULL original_url is a
-- normal state, not an error state.
--
-- WHY THIS FILE EXISTS SEPARATELY
--
-- Per-tenant schemas are NOT auto-migrated. `provision.ts` runs an inline DDL
-- template and nothing reads supabase/migrations/tenant/ at runtime, so the
-- only tenants that get a nullable column from editing the template are those
-- provisioned AFTER the change. Every tenant already in production has its own
-- concrete schema and needs its own ALTER. That is the same trap 00004
-- documents, and it is why editing the template alone is not a migration.
--
-- HOW IT FINDS THE TARGETS
--
-- Schema names are generated at provision time ("tenant_" + 8 hex chars), so
-- no migration can hardcode one. This enumerates public.tenants and runs the
-- statement per schema via format('%I', ...), which quotes the identifier.
--
-- IDEMPOTENT BY CONSTRUCTION
--
--   - DROP NOT NULL is a no-op once the column is already nullable, so
--     re-running is safe and repairs a tenant the first run skipped
--   - tenants whose links table is absent are skipped rather than aborting the
--     whole migration, so one malformed row cannot block everyone else's ALTER
--   - the tenant version record uses ON CONFLICT DO NOTHING
--
-- WHAT THIS DOES NOT DO
--
-- It does not backfill, and it must not. A placeholder destination is worse
-- than none: it makes an unconfigured card forward customers somewhere real,
-- and it leaves no way to tell a placeholder from a genuine destination.
--
-- It also does not touch short_code, which stays NOT NULL. The short_code is
-- what is printed; it exists from the moment the card does.

DO $$
DECLARE
    t RECORD;
BEGIN
    FOR t IN SELECT schema_name FROM public.tenants ORDER BY schema_name LOOP
        -- Skip any registry row whose links table does not exist, so a single
        -- inconsistent row cannot abort the loop for every other tenant.
        CONTINUE WHEN to_regclass(format('%I.links', t.schema_name)) IS NULL;

        -- Dropping NOT NULL is one-way in meaning and safe in practice: no
        -- existing row can become invalid, because a nullable column accepts
        -- every value a NOT NULL one did.
        EXECUTE format(
            'ALTER TABLE %I.links ALTER COLUMN original_url DROP NOT NULL',
            t.schema_name
        );

        -- Version 3 follows version 2 (00004_add_client_ref_to_tenant_links)
        -- in the tenant's own tracking table.
        EXECUTE format(
            'INSERT INTO %I._migrations (version, name)
             VALUES (3, ''00015_original_url_nullable'')
             ON CONFLICT (version) DO NOTHING',
            t.schema_name
        );
    END LOOP;
END $$;

-- Record this migration centrally in the public schema
INSERT INTO public._migrations (version, name)
VALUES (15, '00015_original_url_nullable')
ON CONFLICT (version) DO NOTHING;