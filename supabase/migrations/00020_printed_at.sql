-- Migration 00020: printed_at on every existing tenant's links table
--
-- Adds `printed_at TIMESTAMPTZ`, NULL by default. A non-NULL value means "this
-- link's card was printed", and the timestamp is the run that produced it. It
-- is informational: a card gets lost, torn, or ruined in the cutter, so the
-- link can go back to the queue and be printed again, and that run moves the
-- date forward (odd/tasks/printed-cards-state.md, S1-S5).
--
-- WHY NOT REUSE print_queued_at
--
-- `print_queued_at` answers "is this waiting?", and it is cleared the moment
-- the card is printed. "Was it printed, and when?" has to survive that
-- clearing, so it is its own column.
--
-- WHAT THIS DOES NOT DO
--
-- It does not backfill: every existing link starts with NULL, which the
-- dashboard reads as "never printed". It changes no existing column or row.
--
-- Same shape as 00019: per-tenant schemas are not auto-migrated, so this loops
-- over public.tenants, skips registry rows without a links table, and records
-- tenant version 6 (2 to 5 are taken).

DO $$
DECLARE
    t RECORD;
BEGIN
    FOR t IN SELECT schema_name FROM public.tenants ORDER BY schema_name LOOP
        CONTINUE WHEN to_regclass(format('%I.links', t.schema_name)) IS NULL;

        EXECUTE format(
            'ALTER TABLE %I.links ADD COLUMN IF NOT EXISTS printed_at TIMESTAMPTZ',
            t.schema_name
        );

        EXECUTE format(
            'INSERT INTO %I._migrations (version, name)
             VALUES (6, ''00020_printed_at'')
             ON CONFLICT (version) DO NOTHING',
            t.schema_name
        );
    END LOOP;
END $$;

INSERT INTO public._migrations (version, name)
VALUES (20, '00020_printed_at')
ON CONFLICT (version) DO NOTHING;
