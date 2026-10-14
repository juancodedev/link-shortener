-- Migration 00014: record when a subscription status last changed
--
-- The operator needs to answer "did they already pay, or am I chasing someone I
-- already chased?". `subscription_status` alone cannot tell those apart, because
-- a tenant that has been 'past_due' since last Tuesday looks identical to one
-- changed five minutes ago.
--
-- Deliberately nullable with no default: existing tenants have never had a
-- status change recorded, and inventing a timestamp for them would assert a
-- fact nobody knows. NULL reads as "never changed" and the operator UI shows it
-- as such.
--
-- IDEMPOTENT BY CONSTRUCTION
-- ADD COLUMN IF NOT EXISTS; the bookkeeping write uses ON CONFLICT DO NOTHING.

ALTER TABLE public.tenants
    ADD COLUMN IF NOT EXISTS subscription_updated_at TIMESTAMPTZ;

-- Record this migration centrally in the public schema
INSERT INTO public._migrations (version, name)
VALUES (14, '00014_subscription_updated_at')
ON CONFLICT (version) DO NOTHING;
