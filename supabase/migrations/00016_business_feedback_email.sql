-- Migration 00016: where a tenant wants its private feedback sent
--
-- Lets an owner record the address that should receive customer feedback from
-- the review gate, once, instead of not having anywhere to put it at all.
--
-- WHAT THIS DOES NOT DO
--
-- It does not SEND anything. There is no provider, no queue and no call in the
-- gate path. Feedback continues to land in analytics.tag_feedback exactly as
-- before; this column records intent.
--
-- That separation is deliberate. A customer who writes a review and whose email
-- silently vanishes has no way to know, and neither does the owner — the panel
-- would say "received" while the message evaporated. Sending correctly needs a
-- retry or a durable queue and a decision about what the customer sees on
-- failure, which is a piece of work of its own. It is easier to do well once the
-- address is stored and visible.
--
-- WHY ONE COLUMN AND NOT A SETTINGS TABLE
--
-- The address is per TENANT — per business, not per table. A chain of forty
-- tables must not mean forty inboxes; the person who reads reviews is one
-- person. Per-location would be a second nullable column if it is ever needed.
--
-- NULLABLE, AND THAT IS THE DEFAULT STATE
--
-- Absent means "not configured", which is the state every existing tenant is in
-- and the state the product must keep working in. No backfill: there is nothing
-- to backfill from, and a guessed address is worse than none — it would send a
-- real customer's review to nobody.

ALTER TABLE public.tenants
    ADD COLUMN IF NOT EXISTS feedback_email TEXT;

-- Recorded centrally, like every other migration in this schema.
INSERT INTO public._migrations (version, name)
VALUES (16, '00016_business_feedback_email')
ON CONFLICT (version) DO NOTHING;