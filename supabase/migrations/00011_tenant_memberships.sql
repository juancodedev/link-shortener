-- Migration 00011: tenant_memberships, and a nullable profiles.tenant_id
--
-- This is the schema half of multi-site RBAC. It changes no behaviour: nothing
-- reads the new table until a later change switches the tenant resolver over.
--
-- WHY A JOIN TABLE AT ALL
-- `public.profiles.tenant_id` is NOT NULL, which makes a profile *be* a
-- membership. One Supabase account can therefore reach exactly one restaurant.
-- A chain with forty locations needs one login that reaches all forty, with a
-- per-store role — and a read-only manager of ten of them.
--
-- WHY tenant_id IS NOT DROPPED HERE
-- The column stays. Dropping it is a separate, later change that can only be
-- made once nothing reads it, and today exactly one thing reads it:
-- `createUserProfileTenantMiddleware` in src/middleware/tenant.ts. Expand
-- first, drop later — every intermediate state leaves the shipped
-- single-tenant product working, which is the whole contract of this phase.
--
-- ROLE VOCABULARY
-- `public.profiles.role` is CHECK (role IN ('owner','admin','member')). Nothing
-- in src/ reads it — it is written at provision time and constrained, and that
-- is all. `member` is ambiguous next to `viewer`: "member" reads as "can do
-- things" while `viewer` means "can only look". Since no code reads the old
-- value, this migration introduces the three-role vocabulary as
-- ('owner','admin','viewer') and records the mapping rather than leaving two
-- vocabularies that can never be compared to each other.
--
-- IDEMPOTENT BY CONSTRUCTION
--   - CREATE TABLE / INDEX IF NOT EXISTS → re-running is a no-op
--   - DROP NOT NULL is guarded by a DO block that checks the column first, so
--     re-running does not error
--   - the backfill inserts only rows that do not exist yet, so it converges
--     after one run and stays a no-op forever after
--   - ON CONFLICT DO NOTHING on every version write

-- ---------------------------------------------------------------------------
-- 1. The membership table
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.tenant_memberships (
    id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    profile_id  UUID REFERENCES public.profiles(id) ON DELETE CASCADE NOT NULL,
    tenant_id   UUID REFERENCES public.tenants(id)  ON DELETE CASCADE NOT NULL,
    role        TEXT DEFAULT 'owner' NOT NULL
                CHECK (role IN ('owner', 'admin', 'viewer')),
    created_at  TIMESTAMPTZ DEFAULT now() NOT NULL,

    -- A person has at most one role per restaurant. Without this, "which role
    -- applies" becomes a question every query has to answer, and two rows with
    -- different roles is a data state with no correct interpretation.
    CONSTRAINT tenant_memberships_unique UNIQUE (profile_id, tenant_id)
);

-- Both directions are queried. The resolver looks up "every tenant this
-- profile reaches" (by profile_id), and per-store authorization looks up
-- "does this profile reach this tenant" (by tenant_id).
CREATE INDEX IF NOT EXISTS idx_tenant_memberships_profile
    ON public.tenant_memberships(profile_id);

CREATE INDEX IF NOT EXISTS idx_tenant_memberships_tenant
    ON public.tenant_memberships(tenant_id);

-- ---------------------------------------------------------------------------
-- 2. Relax profiles.tenant_id so the join table is reachable
-- ---------------------------------------------------------------------------
-- NOT NULL is what makes a profile inseparable from one tenant. Dropping it is
-- the enabling change; nothing here reads through it, so it costs nothing yet.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
          FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name   = 'profiles'
           AND column_name  = 'tenant_id'
           AND is_nullable  = 'NO'
    ) THEN
        ALTER TABLE public.profiles ALTER COLUMN tenant_id DROP NOT NULL;
    END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3. Backfill: every existing profile becomes an owner of its own tenant
-- ---------------------------------------------------------------------------
-- Without this, every current user has a profile with a tenant and no
-- membership, and the moment the resolver switches to this table the entire
-- installed base loses access to its own restaurants.
--
-- The role is taken from profiles.role where it means something unambiguous
-- and defaulted to 'owner' otherwise. 'member' maps to 'owner' rather than
-- 'viewer': in a single-tenant world the person who owns the profile is the
-- only person with access, and downgrading them to read-only during a schema
-- migration would lock a paying customer out of their own dashboard.
INSERT INTO public.tenant_memberships (profile_id, tenant_id, role)
SELECT p.id,
       p.tenant_id,
       CASE WHEN p.role IN ('owner', 'admin') THEN p.role ELSE 'owner' END
  FROM public.profiles p
 WHERE p.tenant_id IS NOT NULL
ON CONFLICT (profile_id, tenant_id) DO NOTHING;

-- Record this migration centrally in the public schema
INSERT INTO public._migrations (version, name)
VALUES (11, '00011_tenant_memberships')
ON CONFLICT (version) DO NOTHING;