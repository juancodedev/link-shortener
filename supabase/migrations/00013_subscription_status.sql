-- Migration 00013: subscription_status on public.tenants
--
-- The billing model is per tag / per local, off-platform: a chain orders N tags,
-- we identify each to its local, and payment is arranged outside the product.
-- There is no gateway and no provider webhook, so this column is written by an
-- operator, not by an incoming event.
--
-- `is_active` AND `subscription_status` ARE NOT THE SAME THING
--
--   is_active = false          the business was removed or deprovisioned
--   subscription_status ≠ active  the business exists and has not paid
--
-- They produce different responses and conflating them is how a customer ends up
-- being told their business was deleted when the truth is an unpaid invoice.
--
-- WHY DEFAULT 'active'
-- Every tenant that exists today was onboarded under the old model, where
-- nothing was charged. Defaulting to anything else would 404 every live sticker
-- the moment this migration ran. A new column that silently breaks production is
-- not additive, it is an outage — so the default preserves today's behaviour and
-- the operator opts individual tenants in to 'past_due'.
--
-- The paid/unpaid state therefore lives in Postgres and nowhere else. The KV
-- registry entry has a 24 h TTL, so a status written only to the cache would
-- expire, the JOIN would return clean, and a paused tenant would silently resume
-- serving printed stickers: lost revenue and a broken promise in one incident.
--
-- IDEMPOTENT BY CONSTRUCTION
-- ADD COLUMN IF NOT EXISTS, plus the CHECK re-declared only once, so re-running
-- is a no-op.

ALTER TABLE public.tenants
    ADD COLUMN IF NOT EXISTS subscription_status TEXT DEFAULT 'active' NOT NULL;

-- The CHECK is added separately because ALTER TABLE ADD CONSTRAINT has no
-- IF NOT EXISTS form; adding it to the same statement would fail on re-run.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint c
          JOIN pg_class t ON t.oid = c.conrelid
          JOIN pg_namespace n ON n.oid = t.relnamespace
         WHERE n.nspname = 'public'
           AND t.relname = 'tenants'
           AND c.conname = 'tenants_subscription_status_check'
    ) THEN
        ALTER TABLE public.tenants
            ADD CONSTRAINT tenants_subscription_status_check
            CHECK (subscription_status IN ('active', 'past_due', 'canceled'));
    END IF;
END $$;

-- Record this migration centrally in the public schema
INSERT INTO public._migrations (version, name)
VALUES (13, '00013_subscription_status')
ON CONFLICT (version) DO NOTHING;