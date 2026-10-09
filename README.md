# link-shortener

A multi-tenant URL shortener with per-link click analytics, deployed on Cloudflare Workers.

Short links are tenant-scoped (`/r/{tenant}/{code}`), redirect with a 302, and record every
click — country, device type, and referrer source — into a dedicated analytics schema. Each
tenant lives in its own PostgreSQL schema so link data is physically isolated.

---

## Stack

| Layer | Choice |
| --- | --- |
| Runtime | Cloudflare Workers |
| Framework | Hono 4 |
| Database | PostgreSQL via Supabase, connected over `pg` + Hyperdrive |
| Cache | Workers KV (2 namespaces) |
| Auth | Supabase Auth (JWT, `jose` verification) |
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
| `SUPABASE_ANON_KEY` | yes | Client-side auth from the dashboard |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | Admin operations (user deletion) |
| `JWT_SECRET` | yes | HS256 verification of Supabase JWTs |
| `DATABASE_URL` | no | Overrides the Hyperdrive connection string |

## How tenancy works

A tenant is a namespace, not a login. Each one owns a dedicated PostgreSQL schema named by its
`schema_name`, and every link row lives inside it.

Tenant resolution on a redirect is a two-step lookup:

1. Read `slug` from the KV `TENANT_CACHE` namespace.
2. On a miss, `SELECT ... FROM public.tenants WHERE subdomain = $1 AND is_active = true`,
   then warm the cache.

`TenantResolutionStrategy` (`src/middleware/tenant.ts`) exists as a seam, but
`PathBasedStrategy` is currently the only implementation — there is no subdomain DNS routing
and no API-key auth.

To create a tenant, register a Supabase Auth user first, then `POST /api/tenants`.

## Routes

| Method | Path | Auth | Handler |
| --- | --- | --- | --- |
| `GET` | `/` | public | Landing page |
| `GET` | `/signup`, `/login`, `/reset-password`, `/auth/callback` | public | Auth pages |
| `GET` | `/r/:tenant/:code` | public | Redirect + click tracking |
| `GET` | `/dashboard` | client-side only | Dashboard HTML |
| `POST` | `/api/links` | JWT + tenant | Create link |
| `GET` | `/api/links` | JWT + tenant | List links |
| `PATCH` | `/api/links/:id` | JWT + tenant | Update link |
| `GET` | `/api/links/:id/clicks` | JWT + tenant | Per-link analytics |
| `POST` | `/api/tenants` | JWT | Create tenant |
| `DELETE` | `/api/tenants/:id` | JWT (owner) | Delete tenant |

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

- **Raw hits, not unique visitors.** `ip_hash` is stored but never used for distinct counting.
  Every hit increments the totals, so repeated taps inflate the numbers.
- **Bounded aggregation.** The clicks endpoint returns at most 50 recent rows and reports
  `total` as that row count, so totals can undercount on high-traffic links.

## Data model

```
public.tenants        id, schema_name, display_name, subdomain, owner_id, salt, is_active
public.profiles       id → auth.users, tenant_id, role (owner | admin | member)
analytics.link_clicks id, tenant_id, link_id, ip_hash, user_agent_summary,
                      device_type, country_code, referrer, referrer_source, created_at
{tenant}.links        id, original_url, short_code, title, clicks_count,
                      is_active, expires_at, created_at, updated_at
```

The `{tenant}.links` DDL lives in two places that must stay in sync:
`supabase/migrations/tenant/001_create_links.sql` and the inline template in
`src/tenants/provision.ts`.

Active links are capped at **30 per tenant** (`MAX_ACTIVE_LINKS` in `src/api/links.ts`).

Short codes are random (`nanoid`), not caller-supplied.

## Caching

| Namespace | Key | Value | TTL |
| --- | --- | --- | --- |
| `SHORT_URL_CACHE` | `{slug}:{code}` | `{url, isActive, expiresAt, linkId}` | 24 h |
| `TENANT_CACHE` | `{slug}` | `{schemaName, tenantId, tenantSalt}` | 1 h |

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

Vitest runs against the Workers pool. Redirect lifecycle (cache hit and miss), tenant
resolution, and tracker error handling are covered. Device-type detection, referrer-source
categorization, click-count consistency across cache paths, and the dashboard handler are not.

There is no CI workflow — `.github/` does not exist. Typecheck and tests run locally only.

## License

MIT