-- Migration 00018: businesses (locales) group locations (branches)
--
-- One operator manages several businesses, and one business can have several
-- branches. Until now a tenant held a flat list of locations, so there was no
-- way to say "these three branches are the same café" — and no way to group a
-- comment, a rating or a link by the business it belongs to.
--
--   tenant (the operator)
--     └─ business  ("local", e.g. Café Central)        ← this migration
--          └─ location  ("sucursal", e.g. Providencia)  ← public.locations
--               └─ links                                ← {tenant}.links.location_id
--
-- WHY A NEW LEVEL AND NOT A NEW TENANT PER BUSINESS
--
-- A tenant is a schema, a subscription and a dashboard. The operator would have
-- to switch accounts to see each business. Businesses are only a grouping inside
-- the operator's own tenant; nobody at the business logs in.
--
-- WHAT THIS DOES NOT TOUCH
--
-- Links, scans, ratings and feedback all already point at a location. None of
-- them change: grouping by business is a join through locations.business_id.
--
-- NULLABLE, NO BACKFILL
--
-- Existing locations belong to no business until the operator assigns them.
-- Guessing would group branches the operator never grouped. ON DELETE SET NULL
-- for the same reason: removing a business must not take its branches (and the
-- history attributed to them) with it.
--
-- RLS ON, NO POLICIES
--
-- Same as public.short_code_registry: the Worker connects as the service role
-- and bypasses RLS, and the publishable key shipped to the dashboard must not be
-- able to list every tenant's businesses through the REST API.

CREATE TABLE IF NOT EXISTS public.businesses (
    id         UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    tenant_id  UUID NOT NULL
               REFERENCES public.tenants(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    is_active  BOOLEAN DEFAULT true NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
    CONSTRAINT businesses_name_not_blank CHECK (length(btrim(name)) > 0)
);

-- Unique per tenant and case-insensitive: "Café Central" and "café central" in
-- one list are the same business typed twice, not two businesses.
CREATE UNIQUE INDEX IF NOT EXISTS idx_businesses_tenant_name
    ON public.businesses (tenant_id, lower(name));

ALTER TABLE public.businesses ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.locations
    ADD COLUMN IF NOT EXISTS business_id UUID
    REFERENCES public.businesses(id) ON DELETE SET NULL;

-- Branches of one business: the grouping query's access path.
CREATE INDEX IF NOT EXISTS idx_locations_business
    ON public.locations (business_id);

INSERT INTO public._migrations (version, name)
VALUES (18, '00018_businesses')
ON CONFLICT (version) DO NOTHING;
