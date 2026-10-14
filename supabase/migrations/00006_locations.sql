-- Migration 00006: Per-business locations
--
-- A business can have several sites (a restaurant with a Centro, a Norte and a
-- Sur location). Until now the only grouping a link had was `client_ref`, a
-- free-text field, which groups links *inside* one tenant and cannot express
-- "these three links are the same physical place".
--
-- `public.locations` is that grouping. It belongs in the public schema rather
-- than in a tenant schema on purpose: the tenant registry is already the
-- cross-tenant index, and `analytics.link_clicks` needs to resolve a location
-- for a click that arrives with only a `tenant_id`.
--
-- WHY NOT A TENANT SCHEMA TABLE:
-- Link rows live in `{tenant}.links`. A location is a business-level fact, not
-- a tenant-level one, and Phase 2's `analytics.tag_ratings` has to read it from
-- a shared schema. Putting it in public keeps one copy instead of N.
--
-- IDEMPOTENT BY CONSTRUCTION:
--   - CREATE TABLE IF NOT EXISTS → re-running is a no-op, not an error
--   - CREATE INDEX IF NOT EXISTS  → ditto
--   - the backfill is guarded by NOT EXISTS and ON CONFLICT, so running it
--     twice cannot produce a second default location for the same tenant
--
-- MIGRATION VERSION: public._migrations is at 3 (00001, 00004, 00005).

CREATE TABLE IF NOT EXISTS public.locations (
    id         UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    tenant_id  UUID NOT NULL
               REFERENCES public.tenants(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    slug       TEXT NOT NULL,
    is_active  BOOLEAN DEFAULT true NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
    -- Lowercase, hyphen-separated, no leading/trailing hyphen. Same shape the
    -- printable-link slugs use, so a location label and a sticker slug read
    -- alike to the owner.
    CONSTRAINT locations_slug_format CHECK (slug ~ '^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$')
);

-- Per-tenant location lookups (the dashboard's primary access path)
CREATE INDEX IF NOT EXISTS idx_locations_tenant
    ON public.locations(tenant_id);

-- Unique per tenant, not globally: two businesses may both have a "centro".
CREATE UNIQUE INDEX IF NOT EXISTS idx_locations_tenant_slug
    ON public.locations(tenant_id, slug);

-- Backfill: one location per existing tenant, named after the tenant itself.
--
-- Without this, a tenant that predates the table would have zero locations and
-- nothing could be attached to its links. The per-tenant RBAC rework (Phase 4)
-- is what will let one business hold several locations; until then a tenant and
-- its single location are 1:1 by construction, which is exactly how the system
-- behaves today.
INSERT INTO public.locations (tenant_id, name, slug)
SELECT
    t.id,
    t.display_name,
    -- `subdomain` is already unique and slug-shaped; sanitise defensively so a
    -- value that predates the CHECK cannot abort the whole backfill.
    lower(
      trim(BOTH '-' FROM regexp_replace(t.subdomain, '[^a-zA-Z0-9]+', '-', 'g'))
    )
FROM public.tenants t
WHERE NOT EXISTS (
    SELECT 1 FROM public.locations l WHERE l.tenant_id = t.id
)
ON CONFLICT (tenant_id, slug) DO NOTHING;

-- Record this migration centrally in the public schema
INSERT INTO public._migrations (version, name)
VALUES (4, '00006_locations')
ON CONFLICT (version) DO NOTHING;