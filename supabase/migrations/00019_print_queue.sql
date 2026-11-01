-- Migration 00019: print queue on every existing tenant's links table
--
-- Adds `print_queued_at TIMESTAMPTZ`, NULL by default. A non-NULL value means
-- "this card is waiting to be printed", and the timestamp is when it was sent.
-- The dashboard's Cards section prints the queue; the link leaves it when the
-- owner marks it printed or removes it, or automatically when a destination is
-- saved on it (odd/tasks/print-queue-cards.md, S2-S3).
--
-- WHY A COLUMN AND NOT A TABLE
--
-- The state belongs to one link and must disappear with it, and it is cleared
-- in the same UPDATE that saves a destination. A separate table would need its
-- own cleanup on delete and a second write on configure.
--
-- WHAT THIS DOES NOT DO
--
-- It does not backfill: every existing link starts outside the queue, so no
-- card is printed by surprise. It changes no existing column or row.
--
-- Same shape as 00015: per-tenant schemas are not auto-migrated, so this loops
-- over public.tenants, skips registry rows without a links table, and records
-- tenant version 5 (2, 3 and 4 are taken).

DO $$
DECLARE
    t RECORD;
BEGIN
    FOR t IN SELECT schema_name FROM public.tenants ORDER BY schema_name LOOP
        CONTINUE WHEN to_regclass(format('%I.links', t.schema_name)) IS NULL;

        EXECUTE format(
            'ALTER TABLE %I.links ADD COLUMN IF NOT EXISTS print_queued_at TIMESTAMPTZ',
            t.schema_name
        );

        -- Partial: only queued rows, which are a handful at any time.
        EXECUTE format(
            'CREATE INDEX IF NOT EXISTS idx_links_print_queue ON %I.links(print_queued_at) WHERE print_queued_at IS NOT NULL',
            t.schema_name
        );

        EXECUTE format(
            'INSERT INTO %I._migrations (version, name)
             VALUES (5, ''00019_print_queue'')
             ON CONFLICT (version) DO NOTHING',
            t.schema_name
        );
    END LOOP;
END $$;

INSERT INTO public._migrations (version, name)
VALUES (19, '00019_print_queue')
ON CONFLICT (version) DO NOTHING;
