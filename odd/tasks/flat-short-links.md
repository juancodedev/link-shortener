# Flat Short Links

**Feature status:** implemented, uncommitted
**Created:** 2026-10-09
**Depends on:** Phase 0 and Phase 1 (both merged to `main`)
**Delivery strategy:** `ask-on-risk` (default)

---

## Objective

Serve public short links from a flat URL with no path prefix:

```
https://shorter.juancode.dev/VHvuSpP        (30 chars)
```

instead of the current tenant-scoped form:

```
https://shorter.juancode.dev/r/links/VHvuSpP (42 chars)
```

For NFC tags the length is cosmetic, but for **QR codes printed on a shop window** fewer
characters means lower module density and a more reliable scan through a dirty or worn label.

App routes (`/dashboard`, `/login`) are unaffected.

## Problem

| Gap | Where | Consequence |
| --- | --- | --- |
| Tenant slug occupies the path | `src/router.ts:55` (`/r/:tenant/:code`) | 12 wasted characters when a deployment has one tenant and one domain |
| No flat short-code resolution | — | The tenant cannot be resolved from `/:code` alone |
| Short codes can collide with app routes | `src/api/links.ts:107` (random `nanoid`) | A generated code equal to a reserved route breaks that route |

## Why a global index rather than a single-tenant shortcut

The tenant slug in the path is currently the isolation boundary: the slug selects the schema,
and the query runs inside it. Removing the slug removes that boundary, so the code has to be
mapped back to a tenant before any schema can be read.

**Decision: option A — a global registry.** `short_code → tenant_id`, with a foreign key and
`ON DELETE CASCADE` to `public.tenants`. This preserves multi-tenancy and matches the existing
model. A single-tenant shortcut was considered and rejected: it would make a second client
impossible without another migration.

## Verified behaviour this design relies on

Hono resolves static routes ahead of a single-segment parameter. Measured on the installed
Hono 4.12.26 with both `/dashboard` and `/:code` registered:

```
/dashboard   -> the /dashboard handler   (static wins)
/login       -> the /login handler       (static wins)
/abc123      -> the /:code handler
/r/links/xyz -> the /r/:tenant/:code handler
```

Two consequences:

1. App routes are safe as long as they stay registered.
2. **A single-segment route that is not registered is silently treated as a short code.** The
   reserved-route list below is the guard, and it must be enforced in code rather than
   assumed from the router.

## Scope

### In scope

- `public.short_code_registry` mapping `short_code` → `tenant_id` → `link_id`.
- A `GET /:code` route resolving the tenant through the registry, then redirecting.
- Reserved-route enforcement at code-generation time.
- A KV cache for the registry lookup, mirroring the existing `SHORT_URL_CACHE` pattern.
- Registry maintenance on link create, delete, and tenant deprovision.
- Dashboard and API responses emitting the flat `short_url`.

### Out of scope

- Changing the short-code alphabet or length. This adds a collision guard, not a new format.
- Custom or caller-supplied codes (Phase 3 of the parent plan).
- Cross-tenant analytics rollups.
- Changing the 302 decision, the `client_ref` field, or anything from Phase 0/1.

## Reserved routes

Single-segment app routes that a generated code must never equal:

```
signup
login
dashboard
reset-password
```

`/` (root) is the landing page and is never a short code because it is not a single segment.
Two-segment paths such as `/auth/callback` and `/api/links` cannot match `/:code`.

The list lives in **one** module and is imported by both the code generator and the route
test. A test asserts the list matches the routes actually registered in `src/router.ts`, so
adding an app route without adding it to the reserved list fails CI.

## Tasks

### Schema

- [x] **T1.1** `supabase/migrations/00005_short_code_registry.sql` — create
      `public.short_code_registry(short_code TEXT PRIMARY KEY, tenant_id UUID NOT NULL
      REFERENCES public.tenants(id) ON DELETE CASCADE, link_id UUID, created_at TIMESTAMPTZ)`.
      Follow the conventions in `00001_public_schema.sql`, including index conventions.

**No backfill.** The database was emptied on 2026-10-09: `public.tenants` is empty and there
are no links in any tenant schema. The registry starts empty and is populated from creation
forward. An earlier draft of this document specified a backfill enumerating tenant schemas —
that task was removed because there is no data to copy.

**RLS:** enable RLS on the registry with no permissive policy for the `anon`/`authenticated`
roles. The Worker reaches it over `pg` as the service role and is unaffected, while a browser
holding the publishable key cannot enumerate every tenant's short codes. Match whatever
`00001_public_schema.sql` does for `public.tenants`; if that table is RLS-enabled without a
client policy, do the same here.

### Code generation

- [x] **T2.1** Add `src/utils/short-code.ts` exporting the reserved-route list and a generator
      that rejects any code matching it. Regenerate rather than return a reserved code.
- [x] **T2.2** Add a test asserting the reserved list covers every single-segment route
      registered in `src/router.ts`, so the list cannot drift from reality.

There is no route-migration concern: the app has one deployment, no tenant has been created
since the database was emptied, and no printed tag exists. The reserved-route guard is not
about protecting existing links — it is about stopping a **future** app route from being
silently shadowed by a short code.

### Resolution and routing

- [x] **T3.1** Registry lookup helper in `src/api/links.ts` or a new module, returning
      `{ tenantId, schemaName, tenantSalt, linkId }`.
- [x] **T3.2** KV cache for the registry keyed by short code alone, mirroring
      `SHORT_URL_CACHE` (same TTL and invalidation approach).
- [x] **T3.3** `GET /:code` handler in `src/handlers/redirect.ts` (or a new handler), registered
      **last** so static routes keep precedence. On a registry miss, return 404.
- [x] **T3.4** Remove `/r/:tenant/:code`. Nothing depends on it: the database was emptied on
      2026-10-09, no tags have been printed, and no external link exists in the old format.
      Keeping a fallback route would protect nothing while leaving two live formats and the
      slug-based resolution path still in the code.

### Registry maintenance

- [x] **T4.1** Insert into the registry on link creation.
- [x] **T4.2** Delete from the registry on link deletion, and in `deprovision.ts` — though the
      `ON DELETE CASCADE` on `tenant_id` already covers tenant removal, so verify rather than
      duplicate.
- [x] **T4.3** Invalidate the registry KV cache on any registry write, matching how
      `SHORT_URL_CACHE` is invalidated today.

### Output and docs

- [x] **T5.1** `listLinks` and `createLink` return the flat `short_url`.
- [x] **T5.2** Update the README: new link format, deprecated `/r/` form, and the reserved-route
      guard.

## Acceptance criteria

- `GET /:code` redirects to the link's destination with status 302 and records a click.
- `/dashboard`, `/login`, `/signup`, and `/reset-password` keep working.
- No generated short code can equal a reserved route, enforced by test.
- Deleting a link removes its registry row; deleting a tenant cascades.
- `npm run typecheck` and `npm test` stay green.

## Applicable checks

Test-first applies throughout. The collision guard and the reserved-route/router consistency
test are the highest-value cases: they are what stops a future app route from being silently
shadowed by a short code.

## Progress

Implemented and verified locally on 2026-10-09. **Not committed** — the work is left uncommitted
for review. `npm run typecheck` and `npm test` are green (321 tests, up from 284).

**`00005` is still not applied.** No database was touched: the migration file is written but not
executed. It must be applied to the live database before deploying. The database is empty
(`public.tenants` has 0 rows, no tenant schemas remain), so the migration creates the registry
and nothing else. The first real tenant will be created through `POST /api/tenants`, which
provisions its schema with `client_ref` already present.

### Decisions taken during implementation

- **Registry read and write helpers both live in `src/api/links.ts`.** The plan allowed "a new
  module", but the allowed-edit surface did not include one, and splitting the table's read and
  write shapes across two files would be worse than one owner for it.
- **The registry entry is cached under `reg:{code}` in `SHORT_URL_CACHE`**, same 24h TTL and
  same invalidation discipline as the existing `{slug}:{code}` entry. No new KV namespace, per
  the plan. The prefix is what keeps the two key spaces from colliding.
- **`subdomain` was added to the registry join.** The plan's return shape was
  `{tenantId, schemaName, tenantSalt, linkId}`, but the short-URL KV cache is keyed
  `{slug}:{code}`, and the redirect log line reports the tenant. Both need the slug, and it
  costs nothing — it comes from the same joined row.
- **Cross-tenant collision is enforced, not assumed.** `{tenant}.links.short_code` is only
  UNIQUE per schema, so `createLink` inserts the registry row immediately after the link row and
  checks it. If the claim is lost, the link row is deleted and the attempt is retried; a lost
  claim is never reported as a created link.
- **`ON DELETE CASCADE` was verified, not duplicated.** `deprovision.ts` deletes the registry
  rows explicitly in the same statement as the tenant row, and that is not redundant: the CTE
  RETURNS the removed codes so their KV entries can be invalidated, which the cascade alone
  cannot do.
- **RLS is enabled with no client policy even though `public.tenants` has no RLS.** The plan
  said to match `00001`; `00001` does not enable RLS at all. The brief called RLS
  non-negotiable, and the registry is the enumeration target, so the asymmetry is intentional
  and is called out in the migration. Tightening `public.tenants` is a separate change.
- **`public._migrations` version 3**, not 5: `00001` recorded 1 and `00004` recorded 2, so 3 is
  the next free version in the public schema.

### Known gaps

- `test/tenants/deprovision.test.ts` and `test/cache/shortcode.test.ts` are outside the
  allowed edit surface, so the new deprovision KV-invalidation path and the `reg:{code}` cache
  helpers have no direct unit tests. The deprovision change is query-order compatible with the
  existing suite (it asserts by index and by `toContain`), so it stays green, but it is not
  directly asserted.

## Next step

Review, then apply `00005` to the live database and deploy.