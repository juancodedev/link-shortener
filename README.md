# link-shortener

A multi-tenant URL shortener with per-link click analytics, deployed on Cloudflare Workers.

Short links are flat (`/{code}`), redirect with a 302, and record every click — country, device
type, and referrer source — into a dedicated analytics schema. Each tenant lives in its own
PostgreSQL schema so link data is physically isolated.

---

## Stack

| Layer | Choice |
| --- | --- |
| Runtime | Cloudflare Workers |
| Framework | Hono 4 |
| Database | PostgreSQL via Supabase, connected over `pg` + Hyperdrive |
| Cache | Workers KV (2 namespaces) |
| Auth | Supabase Auth (local HS256 verification via `jose`, Auth API fallback) |
| Tooling | Wrangler 4, Vitest (workers pool), TypeScript strict |

The database is reached with a direct `pg` client over Hyperdrive, not through Supabase REST.
Supabase REST is used only for auth verification and user deletion.

## Getting started

```bash
npm install
cp .dev.vars.example .dev.vars   # fill in secrets
npm run dev                      # wrangler dev
```

Local development uses Hyperdrive pointed at a local Postgres instance. See
[wrangler.jsonc](./wrangler.jsonc) for the connection string.

### Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the local dev server |
| `npm run deploy` | Deploy to Cloudflare |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Run the Vitest suite |
| `npm run types` | Regenerate `worker-configuration.d.ts` |

### Required secrets

Set with `wrangler secret put`; declared in `.dev.vars.example`.

| Secret | Required | Purpose |
| --- | --- | --- |
| `SUPABASE_URL` | yes | Supabase project URL |
| `SUPABASE_ANON_KEY` | yes | Client-side auth from the dashboard, and the Auth API fallback |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | Admin operations (user deletion) |
| `SUPABASE_JWT_SECRET` | yes | HS256 verification of Supabase JWTs, done locally |
| `DATABASE_URL` | no | Overrides the Hyperdrive connection string |

### Optional vars

| Var | Default | Purpose |
| --- | --- | --- |
| `MAX_ACTIVE_LINKS` | `30` | Cap on active links per tenant. Set it from `wrangler.jsonc` `vars` |

## Authentication

`src/middleware/auth.ts` verifies a Supabase access token **locally** with HS256 against
`SUPABASE_JWT_SECRET`. The common path costs no network round trip.

When the secret is absent, or when local verification fails ambiguously, it falls back to
`GET /auth/v1/user` on the Supabase Auth API. The fallback exists so a wrong or stale secret
degrades into one extra hop rather than a total lockout.

The two failure kinds are deliberately treated differently:

- **Definitive** — expired, wrong audience, or structurally malformed. Rejected locally with
  no network call. Nothing a network round trip could change.
- **Ambiguous** — signature mismatch. That is what a misconfigured secret looks like, and also
  what a forged token looks like, so the Auth API gets the final say.

Tokens whose `aud` is not `authenticated` are rejected. The publishable key is itself an HS256
JWT signed with the same secret, so accepting it would let it impersonate a user.

## How tenancy works

A tenant is a namespace, not a login. Each one owns a dedicated PostgreSQL schema named by its
`schema_name`, and every link row lives inside it.

Because a short link carries no tenant slug, the tenant is resolved from
`public.short_code_registry` — one row per short code, mapping it to a `tenant_id`. Resolution
is a KV lookup first, then this join:

```sql
SELECT r.short_code, r.link_id, t.schema_name, t.salt, t.subdomain
  FROM public.short_code_registry r
  JOIN public.tenants t ON t.id = r.tenant_id
 WHERE r.short_code = $1 AND t.is_active = true
```

That registry is the isolation boundary now. **No tenant schema is read before it answers**, and
a miss is a 404 — the handler never falls back to trying another schema. `short_code` is the
table's PRIMARY KEY, which is what makes a code globally unique: `{tenant}.links.short_code` is
only UNIQUE within one schema, so two tenants could each hold `abc1234` and the flat URL would
have nothing to disambiguate them. Link creation claims the code with
`ON CONFLICT DO NOTHING` and retries with a fresh one when the claim is lost.

`TenantResolutionStrategy` (`src/middleware/tenant.ts`) exists as a seam for the API side, but
`PathBasedStrategy` is its only implementation — there is no subdomain DNS routing and no
API-key auth. The redirect path does not use it.

To create a tenant, register a Supabase Auth user first, then `POST /api/tenants`.

Provisioning runs every statement inside an explicit `BEGIN` … `COMMIT` on a single connection.
PostgreSQL DDL is transactional, so `CREATE SCHEMA` and the `CREATE TABLE`/`CREATE INDEX`
statements roll back together — a failure partway through cannot leave a tenant row whose schema
exists but has no `links` table. `withClient` on its own does not give this; it only connects,
runs, and ends.

### Reserved routes

Short codes occupy the whole first path segment, so a generated code must never equal a
registered single-segment app route:

```
signup
login
dashboard
reset-password
```

The list lives in `src/utils/short-code.ts` and `generateShortCode()` regenerates rather than
return one of them. A test derives the single-segment routes from `createApp(...).routes` and
fails if the two disagree, so adding an app route without reserving it breaks the build rather
than silently shadowing every future link with that code. `/` and multi-segment routes need no
entry — `/:code` cannot match them.

## Routes

| Method | Path | Auth | Handler |
| --- | --- | --- | --- |
| `GET` | `/` | public | Landing page |
| `GET` | `/signup`, `/login`, `/reset-password`, `/auth/callback` | public | Auth pages |
| `GET` | `/dashboard` | client-side only | Dashboard HTML |
| `GET` | `/:code` | public | Redirect + click tracking (registered last) |
| `POST` | `/api/links` | JWT + tenant | Create link |
| `GET` | `/api/links` | JWT + tenant | List links |
| `PATCH` | `/api/links/:id` | JWT + tenant | Update link |
| `DELETE` | `/api/links/:id` | JWT + tenant | Delete link |
| `GET` | `/api/links/:id/clicks` | JWT + tenant | Per-link analytics |
| `POST` | `/api/links/batch` | JWT + tenant | Create up to 100 links in one call |
| `POST` | `/api/tenants` | JWT | Create tenant |
| `DELETE` | `/api/tenants/:id` | JWT (owner) | Delete tenant |

`/:code` is registered last and is a genuine catch-all: Hono resolves a registered static route
ahead of a single-segment parameter, which is what keeps the auth pages and `/dashboard`
reachable. The old `/r/:tenant/:code` form was removed — it had no remaining dependents, and
keeping it would have left two live link formats and the slug-based resolution path in place.
Links in the old format no longer resolve; print new ones.

The `/dashboard` route ships fully rendered HTML to any caller and defers authentication to
client-side Supabase session checks in the browser.

## Analytics

On every redirect, `src/analytics/tracker.ts` records one row into `analytics.link_clicks`:

| Field | Source |
| --- | --- |
| `ip_hash` | SHA-256 of the client IP, salted per tenant |
| `country_code` | `CF-IPCountry` |
| `device_type` | `CF-Device-Type`, falling back to user-agent parsing |
| `user_agent_summary` | Truncated user agent |
| `referrer` | `Referer`, query string stripped |
| `referrer_source` | Derived category of the referrer |
| `created_at` | Insert time |

Per-link breakdowns (by country, device, source) are served by `GET /api/links/:id/clicks` and
rendered as expandable panels in the dashboard.

**Current limits.** Two things are worth knowing before relying on these numbers:

- **Bounded aggregation.** The clicks endpoint returns at most 50 recent rows and reports
  `total` as that row count, so totals can undercount on high-traffic links.
- **Visitors are estimated, not counted.** `ip_hash` is a SHA-256 of the client IP salted per
  tenant. Unique-visitor and session figures are derived from it over a 1-day and 30-minute
  window respectively, so they are estimates under NAT and mobile carrier NAT. The dashboard
  surfaces this caveat rather than presenting the numbers as exact.

## Short codes

A link's `short_code` is either generated or supplied by the caller.

**Generated** codes are 7 random characters from an alphabet with visually ambiguous characters
removed. If the drawn code is reserved the generator draws again — free here, because nothing
external depends on it yet.

**Caller-supplied** slugs (`POST /api/links` with a `slug` field) exist for links that will be
printed. `validateCustomSlug` in `src/utils/short-code.ts`:

| Rule | Why |
| --- | --- |
| 3–32 characters | 32 keeps printed QR modules small and scannable |
| `[A-Za-z0-9_-]` only | No `/` — it would break the single-segment route |
| No leading or trailing hyphen | `-foo` reads like a flag |
| Not a reserved route | Such a link would be permanently unreachable |
| Must be a string | `12345` would otherwise become a printed label's literal |

**A supplied slug gets exactly one attempt.** A collision returns 409 naming the slug; it is
never regenerated. A retry would produce a *different* code, and a different code means a sticker
already sitting on a customer's table now points somewhere else — permanently, with no way to
recall it. Generated codes still retry, because nothing depends on them yet.

`POST /api/links/batch` creates up to 100 links in one call, reusing the single-link path so the
two cannot drift. It returns `201` when every item succeeds and `207` when partial, with
`results[]` positionally aligned to the request.

## Data model

```
public.tenants           id, schema_name, display_name, subdomain, owner_id, salt, is_active
public.profiles          id → auth.users, tenant_id, role (owner | admin | member)
public.short_code_registry short_code (PK) → tenants.id (CASCADE), link_id, created_at
analytics.link_clicks    id, tenant_id, link_id, ip_hash, user_agent_summary,
                         device_type, country_code, referrer, referrer_source, created_at
{tenant}.links           id, original_url, short_code, title, clicks_count,
                         is_active, expires_at, created_at, updated_at
```

`public.short_code_registry` has RLS enabled with **no** policy for `anon`/`authenticated`, so a
browser holding the publishable key cannot enumerate every tenant's short codes in one query.
The Worker connects as the service role and bypasses RLS.

The `{tenant}.links` DDL lives in two places that must stay in sync:
`supabase/migrations/tenant/001_create_links.sql` and the inline template in
`src/tenants/provision.ts`.

Active links are capped at **30 per tenant** (`MAX_ACTIVE_LINKS` in `src/api/links.ts`).

Short codes are random (`nanoid`), not caller-supplied, and never equal a reserved app route.

## Caching

| Namespace | Key | Value | TTL |
| --- | --- | --- | --- |
| `SHORT_URL_CACHE` | `{slug}:{code}` | `{url, isActive, expiresAt, linkId}` | 24 h |
| `SHORT_URL_CACHE` | `reg:{code}` | `{tenantId, schemaName, tenantSalt, subdomain, linkId}` | 24 h |
| `TENANT_CACHE` | `{slug}` | `{schemaName, tenantId, tenantSalt}` | 1 h |

The `reg:` prefix keeps the registry entry from ever colliding with a `{slug}:{code}` short-URL
entry; a slug cannot contain `:`.

A redirect served from `SHORT_URL_CACHE` skips the link query but still records the click.
Cache entries are invalidated on link update/delete and tenant deprovision — but **not** when
`original_url` changes, since the update endpoint only exposes `is_active` and `title`.

Click tracking runs inside `waitUntil`, so a Worker evicted mid-request can drop the event.

## Layout

```
src/
├── api/          link + tenant REST handlers (JWT-protected)
├── cache/        KV wrappers for short codes and tenant resolution
├── db/           pg client over Hyperdrive, schema helpers
├── handlers/     landing, redirect, dashboard (HTML), auth pages
├── middleware/   auth, tenant resolution, error handling
├── analytics/    click tracker
├── tenants/      provision / deprovision (creates tenant schemas)
├── utils/        short codes, IP hashing, validation
└── router.ts     route table
test/             mirrors src/ — middleware, cache, api, handlers, analytics, db
openspec/         archived MVP spec, design, and verification report
```

## Testing

```bash
npm test
```

Vitest runs against the Workers pool. Redirect lifecycle (cache hit and miss), short-code
registry resolution, the reserved-route/router consistency guard, and tracker error handling are
covered. Device-type detection, referrer-source categorization, click-count consistency across
cache paths, and the dashboard handler are not.

There is no CI workflow — `.github/` does not exist. Typecheck and tests run locally only.

## License

MIT