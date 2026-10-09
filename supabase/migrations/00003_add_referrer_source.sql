-- Migration 00003: Add referrer_source to analytics.link_clicks
-- Classifies each click by referrer origin ('Direct', 'Social', 'News', 'Search', 'Email')
-- so the dashboard "By Source" breakdown can group clicks instead of collapsing to Direct.
--
-- NOTE: this column is already written by the click tracker, so already-deployed
-- databases must run this migration — not just fresh ones.

-- Referrer classification: broad bucket derived from the Referer header
ALTER TABLE IF NOT EXISTS analytics.link_clicks
    ADD COLUMN IF NOT EXISTS referrer_source TEXT;  -- 'Direct', 'Social', 'News', 'Search', 'Email', or NULL

-- Record this migration
INSERT INTO analytics._migrations (version, name)
VALUES (2, '00003_add_referrer_source')
ON CONFLICT (version) DO NOTHING;