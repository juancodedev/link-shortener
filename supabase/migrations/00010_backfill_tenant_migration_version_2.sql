-- Migration 00010: Backfill tenant migration version 2
--
-- The tenant's own version table jumped 1 -> 3. Version 2 is 00004
-- (client_ref), and the column it adds IS present on that tenant's links
-- table — the tenant was provisioned after client_ref landed in TENANT_DDL, so
-- 00004's ALTER never had to run for it and never recorded itself.
--
-- The end state matches what version 2 delivers, so the gap is recorded here
-- rather than left open. Without this, a future reader auditing the sequence
-- sees 1, 3, 4 and cannot tell whether something was skipped or never applied.
--
-- Only tenants whose links table actually carries the column are recorded, so
-- this cannot claim a migration ran for a tenant it did not reach.

DO $$
DECLARE
    t RECORD;
BEGIN
    FOR t IN
        SELECT schema_name
          FROM public.tenants
         WHERE to_regclass(format('%I.links', schema_name)) IS NOT NULL
         ORDER BY schema_name
    LOOP
        CONTINUE WHEN NOT EXISTS (
            SELECT 1 FROM information_schema.columns
             WHERE table_schema = t.schema_name
               AND table_name   = 'links'
               AND column_name  = 'client_ref'
        );

        EXECUTE format(
            'INSERT INTO %I._migrations (version, name)
             VALUES (2, ''00004_add_client_ref_to_tenant_links'')
             ON CONFLICT (version) DO NOTHING',
            t.schema_name
        );
    END LOOP;
END $$;
