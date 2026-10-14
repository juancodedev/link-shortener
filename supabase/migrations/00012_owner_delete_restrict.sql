-- Migration 00012: stop an owner deletion from cascading away live businesses
--
-- `public.tenants.owner_id` was `ON DELETE CASCADE`, so deleting the Supabase
-- Auth user that owned a tenant deleted the tenant row — and through it
-- `locations`, `tenant_memberships`, `short_code_registry` and every
-- `analytics.*` row.
--
-- WHAT THAT COST, PRECISELY
-- `short_code_registry` is what `resolveRegistryEntry` reads. With the registry
-- row gone, every printed sticker for that location stops resolving and returns
-- 404. The customer's phone keeps pointing at a sticker that no longer leads
-- anywhere.
--
-- The per-tenant schema was NOT lost — `{schema}.links` holds no foreign key to
-- `public.tenants`, so the links rows survive as orphans. That makes this a loss
-- of service rather than of data: irreversible in practice, since replacing
-- printed stickers is expensive, and recoverable only by hand.
--
-- WHY THIS MATTERS ONLY NOW
-- With one tenant per account, "delete the account" and "close the business" are
-- the same act, so the cascade matched the intent. Under multi-site — one chain
-- profile owning forty tenants — the same click destroys forty businesses. This
-- is the same shape as the two deprovision bugs fixed in 00011: correct in
-- single-tenant, data loss once a second tenant exists.
--
-- WHY RESTRICT AND NOT SET NULL
-- `SET NULL` would leave the tenant row alive and serving, but
-- `DELETE /api/tenants` authorizes on `owner_id = userId`. A NULL owner makes
-- every such tenant un-deletable through the API — a silent orphan the operator
-- cannot clean up and cannot explain.
--
-- `RESTRICT` makes the dangerous act fail loudly at the database instead. The
-- operator deprovisions each tenant first — which is the correct order anyway,
-- since deprovision drops the schema and returns the codes for KV invalidation —
-- and the account becomes deletable once no tenant references it.
--
-- `is_active = false` remains the soft stop: the redirect already returns 404
-- for an inactive tenant, so a tenant that must stop serving without ceasing to
-- exist is already expressible without deleting anything.
--
-- IDEMPOTENT BY CONSTRUCTION
-- The DROP/CREATE pair runs inside a DO block guarded on the current delete
-- rule, so re-running is a no-op rather than an error, and a database that
-- already has RESTRICT is left alone.

DO $$
BEGIN
    -- Only touch the constraint when it still cascades.
    IF EXISTS (
        SELECT 1
          FROM pg_constraint c
          JOIN pg_class t ON t.oid = c.conrelid
          JOIN pg_namespace n ON n.oid = t.relnamespace
          JOIN pg_attribute a
            ON a.attrelid = t.oid AND a.attname = 'owner_id'
         WHERE n.nspname = 'public'
           AND t.relname = 'tenants'
           AND c.contype = 'f'
           AND c.confdeltype = 'c'   -- 'c' = CASCADE
    ) THEN
        ALTER TABLE public.tenants
            DROP CONSTRAINT tenants_owner_id_fkey;

        -- The constraint is auto-named, so it is recreated explicitly rather
        -- than relying on Postgres deriving the same name. Re-declaring it
        -- verbatim from 00001 apart from the delete rule keeps the two copies
        -- comparable by eye.
        ALTER TABLE public.tenants
            ADD CONSTRAINT tenants_owner_id_fkey
            FOREIGN KEY (owner_id)
            REFERENCES auth.users(id)
            ON DELETE RESTRICT;
    END IF;
END $$;

-- Record this migration centrally in the public schema
INSERT INTO public._migrations (version, name)
VALUES (12, '00012_owner_delete_restrict')
ON CONFLICT (version) DO NOTHING;