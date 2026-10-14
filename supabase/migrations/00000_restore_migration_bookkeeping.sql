-- Migration 00000: Restore the migration bookkeeping tables
--
-- The public and analytics _migrations tables were part of 00001 and 00002, but
-- this database was created from an earlier revision of those files that did
-- not include them. The SCHEMA was applied; the bookkeeping was not. Every
-- migration since then ends with an INSERT into one of these tables, so each
-- one would have failed on its final statement — after its DDL had already
-- taken effect.
--
-- This creates both tables and records the migrations whose effects are
-- verifiably present, so the version tables are truthful rather than empty.
--
-- This file is numbered 00000 so it sorts before everything it repairs.

CREATE TABLE IF NOT EXISTS public._migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    applied_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS analytics._migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    applied_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

-- Public schema: verified present — public.tenants, public.profiles and
-- public.short_code_registry all exist, and the tenant links table carries
-- client_ref (00004).
INSERT INTO public._migrations (version, name) VALUES
    (1, '00001_public_schema'),
    (2, '00004_add_client_ref_to_tenant_links'),
    (3, '00005_short_code_registry')
ON CONFLICT (version) DO NOTHING;

-- Analytics schema: analytics.link_clicks exists with both referrer and
-- referrer_source, so 00003 was applied too.
INSERT INTO analytics._migrations (version, name) VALUES
    (1, '00002_analytics_schema'),
    (2, '00003_add_referrer_source')
ON CONFLICT (version) DO NOTHING;
