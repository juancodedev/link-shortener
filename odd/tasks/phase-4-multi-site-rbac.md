# Phase 4 — Multi-site RBAC

The expensive phase, and the reason it sits here: it delivers nothing a single-site customer can
see, so it must not compete with the product for the first days of delivery.

## Objective

Let one person be a member of several restaurants and switch between them, with per-store
isolation that is actually enforced rather than assumed.

## Problem

A chain with forty locations has one Supabase account and one `tenant_id` on `public.profiles`.
Either the chain gets forty logins — and a manager of ten stores logs in and out ten times a day —
or the codebase has no place to record "this person reaches these ten stores, and that one is
read-only". The second is the current state.

Worse, the shape is actively misleading: `profiles.tenant_id` is `NOT NULL`, so a profile *is* a
membership. Any code that reads `profiles.tenant_id` to decide what someone may see looks
correct and is correct — for the single-tenant world the system is in today.

## Scope

- **T4.1** `public.tenant_memberships(id, profile_id → public.profiles.id ON DELETE CASCADE,
  tenant_id → public.tenants.id ON DELETE CASCADE, role, created_at, UNIQUE (profile_id, tenant_id))`.
- **T4.2** Decide what `public.profiles` becomes. `tenant_id` is `NOT NULL` today, so the join
  table is inert until that changes. **Migrate the column out — expand first, drop later.**
- **T4.3** Reconcile the role vocabulary. `profiles.role` is `CHECK (role IN ('owner','admin','member'))`;
  memberships introduce `('owner','admin','viewer')`. Two vocabularies mean a membership can never
  be compared to a profile role.
- **T4.4** Context switcher: `GET /api/tenants` returns every tenant the user can reach, and an
  explicit context selects one per request.
- **T4.5** Enforce per-store isolation: a membership in tenant A grants nothing in tenant B.

## Constraints

- **Additive only.** The migration that relaxes `profiles.tenant_id` must not drop it in the same
  change that starts reading the join table. Every intermediate state must leave the existing
  single-tenant product working.
- **Re-runnable.** Follow the `00004` `IF NOT EXISTS` pattern already used in this repo, so a
  migration applied twice is a no-op rather than an error.
- **Isolation is the whole point.** T4.5 is a security property. A membership in tenant A that
  leaks data from tenant B is worse than not shipping the phase at all.
- The tenant isolation boundary is the `tenant_id` predicate on the query — never a check that
  happens to sit in front of it.

## Acceptance criteria

- One profile can hold memberships in several tenants, each with its own role.
- `GET /api/tenants` returns exactly the tenants that profile can reach — no more, no fewer.
- Selecting tenant B while holding a membership only in tenant A returns nothing from B.
- Every dashboard and links query is scoped by the *selected* tenant, not by `profiles.tenant_id`.
- A user with no membership in the requested tenant gets a refusal, not an empty result that looks
  like a tenant with no data.
- `pnpm run typecheck` and `pnpm test` stay green.

## Route

Delegated. T4.1–T4.5 touch auth middleware, the router, the links handler, the dashboard, the
provisioning path and the migrations — more than two non-trivial files, and reading that prepares
the write would inflate this context for no benefit.

## T4.0 — Mapping result (done)

The map is smaller and cleaner than the task assumed, which makes the phase far cheaper than
budgeted. But it surfaced one thing the original draft did not anticipate.

**Exactly one reader of `profiles.tenant_id`:**

- `src/middleware/tenant.ts:194` — `createUserProfileTenantMiddleware()`. Its query is
  `SELECT t.id, t.schema_name, t.subdomain, t.salt FROM public.profiles p JOIN public.tenants t ON p.tenant_id = t.id WHERE p.id = $1 AND t.is_active = true LIMIT 1`.

**That `LIMIT 1` is the whole phase.** It is not a correctness bug today — with one membership per
profile it returns the only row. The moment a profile holds two memberships it silently picks one,
arbitrarily, and every API route inherits that choice. Phase 4 is mostly the removal of this clause
and the addition of an explicit selector.

**Zero readers of `profiles.role`.** Grepped the whole of `src/` — the column is written at
provision (`src/tenants/provision.ts:127`) and constrained by a CHECK, but nothing reads it. So T4.3
is not a vocabulary migration over live code; it is free to define the right vocabulary now and
backfill, with no behavioural change to preserve.

**Authorization is structural, not checked.** Every tenant-scoped route is
`auth → userProfileTenantMiddleware → handler` (`src/router.ts:73-102`), and each handler scopes by
`c.get('tenant').tenantId`. There is no per-tenant permission check anywhere, because with one
profile = one tenant there was nothing to check. Consequence for T4.5: isolation currently rests
entirely on the middleware resolving the *right* tenant. Phase 4 makes that resolution explicit and
user-chosen, so isolation must become a **verified property of the resolver**, tested, not an
emergent one.

**Two routes outside the pattern — both need a decision:**

- `GET /dashboard` (`src/router.ts:66`) has **no server-side auth middleware**. It authenticates
  client-side (`src/handlers/dashboard.ts:328`, Supabase session), and every API call it makes
  carries a token. That is fine today because the dashboard only calls `/api/*` routes, which *are*
  protected. It stays out of scope, but it must not become a place where tenant context is trusted.
- `POST /api/tenants` (`src/router.ts:105`) is `auth` only — no tenant middleware, because there is
  no tenant yet. It calls `provisionTenant(env, user.userId, ...)`, which inserts the `profiles` row
  (`src/tenants/provision.ts:127`). **This is where the first membership must be created**, or a new
  tenant will be invisible to every `/api/*` route the moment Phase 4 switches the resolver to the
  join table. Not optional — it is the one coupling that would break the product at cutover.

**Migration pattern** (from `00004`): idempotent DDL guarded by `IF NOT EXISTS` / `DO $$ … $$`,
plus an explicit update of the bookkeeping row. Reuse verbatim.

## Tasks

- [x] **T4.0** Map every current reader of `profiles.tenant_id` and `profiles.role`. → done, above.
- [x] **T4.1** `00011_tenant_memberships.sql` — done. Join table with `UNIQUE (profile_id, tenant_id)`, both FK indexes, `CHECK (role IN ('owner','admin','viewer'))`, idempotent backfill of every existing profile as owner of its own tenant, and `DROP NOT NULL` on `profiles.tenant_id` guarded by a `DO` block.
- [ ] **T4.2** `00011` ships the nullable change; the column is **kept**, per expand-first. — the join table, indexes on both FK columns, and
  the `UNIQUE (profile_id, tenant_id)`.
- [x] **T4.2** Migration that makes `profiles.tenant_id` nullable. **Column stays.** → done inside `00011`.
- [ ] **T4.3** One role vocabulary. Decide and document which of `member` / `viewer` survives, and
  what happens to existing rows.
- [ ] **T4.4** `GET /api/tenants` + explicit per-request tenant context.
- [ ] **T4.5** Isolation enforcement, with a test that holds a membership in A and reads B.

## Verification

- `pnpm run typecheck`
- `pnpm test`
- A test proving cross-tenant isolation, written before T4.5 is considered done.

## Progress

T4.0–T4.3 done. Nothing reads `tenant_memberships` yet, so the product is unchanged.

### The bug this phase found before it found itself

`deprovisionTenant` assumed one profile means one tenant, and that assumption was baked
into two places that both destroy a Supabase account, because
`profiles.id REFERENCES auth.users(id) ON DELETE CASCADE`:

1. `DELETE FROM public.profiles WHERE tenant_id = $1` — deleted the profile of anyone who
   belonged to a second tenant, cascading into their login.
2. `DELETE .../auth/v1/admin/users/{ownerUserId}` — ran unconditionally, so removing one
   store from a chain destroyed the account and with it access to every other store.

Both are correct in a single-tenant world and both are data loss the moment a second tenant
exists — the failure only appears at exactly the moment the feature starts working, which is
when nobody is still looking for it. Both now require "no memberships anywhere", and both
directions are tested: the login **survives** when other stores remain, and is **deleted** when
the last one goes.

## Verification

- `pnpm run typecheck` — clean
- `pnpm test` — 578 → **587**, 26 files, all green

## Decisions and corrections

- **T4.2 correction carried forward from the original draft:** it proposed
  `REFERENCES {schema}.locations` in the wrong place. Same discipline applies here — `locations`
  lives in `public`, and per-tenant tables are dropped by the schema teardown, so a constraint
  against a tenant-scoped table buys nothing and breaks re-runnable migrations.
- **Expansion, not replacement.** `profiles.tenant_id` is not dropped in Phase 4. A user who
  belongs to one store keeps working with no context selected. Dropping it is a later change that
  can only be made once nothing reads it — which is not true yet.