-- Tenant template migration 001: Create links table
-- This DDL is executed per-tenant during provisioning (CREATE SCHEMA + run this template).
-- Uses {schema} placeholder replaced at runtime with the validated, double-quoted schema name.
-- All statements use IF NOT EXISTS for idempotent execution.

-- Links table: one row per shortened URL
CREATE TABLE IF NOT EXISTS {schema}.links (
    id           UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    original_url TEXT NOT NULL,
    short_code   TEXT NOT NULL,
    title        TEXT,                              -- Optional display name
    clicks_count INTEGER DEFAULT 0 NOT NULL,
    is_active    BOOLEAN DEFAULT true NOT NULL,
    expires_at   TIMESTAMPTZ,                       -- NULL = never expires
    created_at   TIMESTAMPTZ DEFAULT now() NOT NULL,
    updated_at   TIMESTAMPTZ DEFAULT now() NOT NULL
);

-- Per-tenant unique index on short_code
-- Two tenants CAN both use 'abc123' (different schemas = no collision)
CREATE UNIQUE INDEX IF NOT EXISTS idx_links_short_code
    ON {schema}.links(short_code);

-- Index for listing links by creation date (descending)
CREATE INDEX IF NOT EXISTS idx_links_created_at
    ON {schema}.links(created_at DESC);

-- Partial index for active links with expiration (redirect lookup optimization)
CREATE INDEX IF NOT EXISTS idx_links_active_expires
    ON {schema}.links(is_active, expires_at) WHERE is_active = true;

-- Migration tracking table (one per tenant schema)
CREATE TABLE IF NOT EXISTS {schema}._migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    applied_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

-- Record this migration
INSERT INTO {schema}._migrations (version, name)
VALUES (1, '001_create_links')
ON CONFLICT (version) DO NOTHING;
