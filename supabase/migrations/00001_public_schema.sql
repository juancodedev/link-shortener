-- Migration 00001: Public schema — Tenant registry + user-to-tenant mapping
-- Creates the shared tenant registry and profile tables in the public schema.
-- Supabase already provides the `public` schema; this migration adds tables to it.

-- Tenant registry: one row per provisioned tenant
CREATE TABLE IF NOT EXISTS public.tenants (
    id           UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    schema_name  TEXT UNIQUE NOT NULL,              -- e.g. 'tenant_a7f3d2b1'
    display_name TEXT NOT NULL,                     -- e.g. 'Acme Corp'
    subdomain    TEXT UNIQUE NOT NULL,              -- e.g. 'acme' (path segment)
    owner_id     UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    salt         TEXT NOT NULL DEFAULT gen_random_uuid()::text,  -- per-tenant salt for IP hashing (REQ-A002)
    is_active    BOOLEAN DEFAULT true NOT NULL,
    created_at   TIMESTAMPTZ DEFAULT now() NOT NULL
);

-- User-to-tenant mapping: one profile row per user (user can belong to one tenant)
CREATE TABLE IF NOT EXISTS public.profiles (
    id         UUID REFERENCES auth.users(id) ON DELETE CASCADE PRIMARY KEY,
    tenant_id  UUID REFERENCES public.tenants(id) ON DELETE CASCADE NOT NULL,
    role       TEXT DEFAULT 'member' NOT NULL
               CHECK (role IN ('owner', 'admin', 'member')),
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

-- Indexes
-- Partial index: only active tenants for subdomain lookups (tenant resolution hot path)
CREATE INDEX IF NOT EXISTS idx_tenants_subdomain
    ON public.tenants(subdomain) WHERE is_active = true;

-- Owner lookup for tenant deletion ownership verification
CREATE INDEX IF NOT EXISTS idx_tenants_owner
    ON public.tenants(owner_id);

-- Profile lookup by tenant (admin queries, deletion cascade verification)
CREATE INDEX IF NOT EXISTS idx_profiles_tenant
    ON public.profiles(tenant_id);

-- Migration tracking table for the public schema
-- Records which migrations have been applied to this schema
CREATE TABLE IF NOT EXISTS public._migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    applied_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

-- Record this migration
INSERT INTO public._migrations (version, name)
VALUES (1, '00001_public_schema')
ON CONFLICT (version) DO NOTHING;
