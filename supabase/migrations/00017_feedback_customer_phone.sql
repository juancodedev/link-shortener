-- Migration 00017: a phone number on private feedback, beside the email
--
-- The review screen now asks for a phone first and an email second. A phone is
-- what an owner actually uses to call a customer back about a bad night; an
-- email is the fallback.
--
-- WHY A NEW COLUMN AND NOT customer_contact
--
-- `customer_contact` was a single free-text field, and every row written so far
-- holds an email in it (the form's input was type="email"). Packing two values
-- into it would make every reader parse a string to find out which one it got.
-- The email stays where it already is; the phone gets its own column.
--
-- NULLABLE, NO BACKFILL
--
-- Both contacts are optional on the form, and no existing comment carries a
-- phone. There is nothing to backfill from.

ALTER TABLE analytics.tag_feedback
    ADD COLUMN IF NOT EXISTS customer_phone TEXT;

-- Record this migration in the analytics schema (last was 3, 00009)
INSERT INTO analytics._migrations (version, name)
VALUES (4, '00017_feedback_customer_phone')
ON CONFLICT (version) DO NOTHING;
