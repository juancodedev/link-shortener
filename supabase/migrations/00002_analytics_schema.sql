-- Migration 00002: Analytics schema — Shared cross-tenant click tracking
-- Creates the analytics schema with a shared link_clicks table for admin visibility.

-- Create analytics schema if it doesn't exist
CREATE SCHEMA IF NOT EXISTS analytics;

-- Shared click tracking table: records every redirect event
-- link_id has NO foreign key because links live in per-tenant schemas
-- tenant_id references public.tenants for cascade cleanup on deprovision
CREATE TABLE IF NOT EXISTS analytics.link_clicks (
    id                UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    tenant_id         UUID REFERENCES public.tenants(id) ON DELETE CASCADE NOT NULL,
    link_id           UUID NOT NULL,               -- Logical reference; no FK (per-tenant schemas)
    ip_hash           TEXT,                         -- SHA-256(ip + per-tenant salt), NULL if IP missing
    user_agent_summary TEXT,                        -- e.g. "Chrome 125 / macOS", never raw UA
    device_type       TEXT,                         -- 'mobile', 'desktop', 'tablet', or NULL
    country_code      TEXT,                         -- ISO 3166-1 alpha-2 from CF-IPCountry
    referrer          TEXT,                         -- Stripped of query params, or NULL
    created_at        TIMESTAMPTZ DEFAULT now() NOT NULL
);

-- Indexes for analytics queries
CREATE INDEX IF NOT EXISTS idx_link_clicks_tenant
    ON analytics.link_clicks(tenant_id);

CREATE INDEX IF NOT EXISTS idx_link_clicks_link
    ON analytics.link_clicks(link_id);

CREATE INDEX IF NOT EXISTS idx_link_clicks_created
    ON analytics.link_clicks(created_at DESC);

-- Composite index for per-link time-series queries
CREATE INDEX IF NOT EXISTS idx_link_clicks_link_time
    ON analytics.link_clicks(link_id, created_at DESC);

-- Migration tracking table for the analytics schema
CREATE TABLE IF NOT EXISTS analytics._migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    applied_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

-- Record this migration
INSERT INTO analytics._migrations (version, name)
VALUES (1, '00002_analytics_schema')
ON CONFLICT (version) DO NOTHING;
