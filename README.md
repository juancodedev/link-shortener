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
| Package manager | pnpm (`packageManager` pinned; `pnpm-lock.yaml` is the only lockfile) |

The database is reached with a direct `pg` client over Hyperdrive, not through Supabase REST.
Supabase REST is used only for auth verification and user deletion.

## Getting started

```bash
pnpm install
cp .dev.vars.example .dev.vars   # fill in secrets
pnpm run dev                      # wrangler dev
```

Local development uses Hyperdrive pointed at a local Postgres instance. See
[wrangler.jsonc](./wrangler.jsonc) for the connection string.

### Scripts

| Command | Purpose |
| --- | --- |
| `pnpm run dev` | Start the local dev server |
| `pnpm run deploy` | Deploy to Cloudflare |
| `pnpm run typecheck` | `tsc --noEmit` |
| `pnpm test` | Run the Vitest suite |
| `pnpm test:watch` | Run the Vitest suite in watch mode |
| `pnpm run types` | Regenerate `worker-configuration.d.ts` |

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

Every route in the system, grouped by who is allowed to call it. The grouping is the point:
each boundary below is a different authentication mechanism, not a different level of politeness.

### Public — no credentials

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/` | Landing page |
| `GET` | `/signup` | Signup page |
| `GET` | `/login` | Login page |
| `GET` | `/reset-password` | Password reset page |
| `GET` | `/auth/callback` | Supabase OAuth/magic-link callback |
| `GET` | `/dashboard` | Dashboard HTML — authentication deferred to the browser |
| `POST` | `/api/gate` | Action screen: Google redirect, private feedback, optional rating |
| `GET` | `/:code` | Short-link resolution, click tracking, action screen (registered last) |

`/api/gate` is public by necessity. The person scanning a sticker is a **customer of the business,
not a user of this dashboard** — requiring a JWT here would mean the product cannot work at all. It
is the only write path that accepts anonymous callers, and it is rate limited per short code rather
than per IP (a per-IP limit would punish a whole CGNAT range for one scanner's behaviour). See
[Analytics](#analytics) for what that endpoint does and does not guarantee.

`/dashboard` ships fully rendered HTML to any caller and defers authentication to client-side
Supabase session checks. It is a shell, not a data leak: every figure it renders comes from an
authenticated API route below.

`/:code` is registered last and is a genuine catch-all: Hono resolves a registered static route
ahead of a single-segment parameter, which is what keeps `/dashboard` and the auth pages reachable.
The old `/r/:tenant/:code` form was removed — it had no remaining dependents, and keeping it would
have left two live link formats and the slug-based resolution path in place. **Links in the old
format no longer resolve; print new ones.**

### Operator — `Authorization: Bearer $OPERATIONS_TOKEN`

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/ops/tenants` | List tenants with subscription status |
| `POST` | `/api/ops/tenants/subscription` | Record a paid or lapsed subscription |

**These never accept a customer JWT.** Billing is collected off-platform and recorded by an
operator, so a route that accepted a customer token would let a client flip their own status to
`active` and grant themselves service they did not pay for. The two credentials are not
interchangeable and not composable.

Every mutation flushes the tenant's `reg:{code}` KV entries so the change takes effect immediately.

### Customer API — JWT + tenant in context

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/tenant/feedback-email` | Where this business wants its private customer feedback sent |
| `PUT` | `/api/tenant/feedback-email` | Set or clear it |
| `GET` | `/api/tenants` | List tenants this user belongs to (the switcher's data source) |
| `POST` | `/api/links` | Create one link |
| `GET` | `/api/links` | List the tenant's links |
| `PATCH` | `/api/links/:id` | Update a link |
| `DELETE` | `/api/links/:id` | Delete a link |
| `GET` | `/api/links/:id/clicks` | Per-link analytics: country, device, source |
| `POST` | `/api/links/batch` | Create up to 100 links in one call |
| `GET` | `/api/links/:id/qr.svg` | One card's QR, as a print-ready SVG |
| `POST` | `/api/links/qr-sheet.zip` | A batch of cards as a ZIP: one SVG per card plus `links.csv` |
| `GET` | `/api/locations` | List locations (tables, zones) with a link count each |
| `POST` | `/api/locations` | Create one location |
| `PATCH` | `/api/locations/:id` | Rename a location or switch it off |
| `GET` | `/api/clients/metrics` | Per-`client_ref` visitor rollup |
| `GET` | `/api/review-gate/feedback` | What customers wrote, newest first |
| `GET` | `/api/review-gate/feedback.csv` | The same, as a download |
| `GET` | `/api/review-gate/metrics` | Action-screen views, sentiment, derivation rate |

Tenant-scoped routes run `auth` → `createTenantMembershipMiddleware` → handler. **That chain is
load-bearing, not decorative.** The middleware puts the tenant's Postgres schema in context, and
every query in those handlers qualifies against it. Registering any of these with `auth` alone would
not merely return the wrong numbers — it would throw, and any later edit that made it tolerate an
absent tenant would read across tenants.

Select the tenant with the `X-Tenant-Slug` header. Without it these routes return `409
tenant_required`.

### Walkthrough: manufacture a pack of review cards

The product is a printed object. A card is **manufactured before its destination exists**: the owner
creates the batch, the designer prints each short code as a QR, and the real review URL is loaded
later. Everything below is what that flow needs.

#### 1. Get a token and name your tenant

```bash
# Log in through the dashboard at /login and grab the access token, or:
TOKEN=$(curl -s -X POST "$SUPABASE_URL/auth/v1/token?grant_type=password" \
  -H "apikey: $SUPABASE_ANON_KEY" -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","password":"..."}' | jq -r .access_token)

curl -s "$BASE/api/tenants" -H "Authorization: Bearer $TOKEN"
```

Every write below needs `X-Tenant-Slug`. Without it these routes return `409 tenant_required`.

```bash
export SLUG="acme"          # the subdomain from /api/tenants
```

#### 2. Create the pack

Ten links, no destination, gate on. `is_gated: true` is what makes a scan record which path the
customer took — **without it the customer is forwarded straight to the destination and the
satisfaction panel stays at zero forever.**

```bash
curl -s -X POST "$BASE/api/links/batch" \
  -H "Authorization: Bearer $TOKEN" -H "X-Tenant-Slug: $SLUG" \
  -H "Content-Type: application/json" \
  -d '{"links":[
        {"is_gated":true,"client_ref":"mesa-1"},
        {"is_gated":true,"client_ref":"mesa-1"},
        {"is_gated":true,"client_ref":"mesa-1"},
        {"is_gated":true,"client_ref":"mesa-1"},
        {"is_gated":true,"client_ref":"mesa-1"}
      ]}'
```

The response reports one result per input, positionally aligned:

```json
{
  "created": 5,
  "failed": 0,
  "results": [
    { "index": 0, "status": 201,
      "link": { "id": "…", "short_code": "X4tonhH", "short_url": "https://…/X4tonhH",
                "original_url": null, "client_ref": "mesa-1",
                "is_gated": true, "location_id": null, "created_at": "…" } }
  ]
}
```

`201` when every item succeeded, `207` when partial. A pack of stickers is worthless if one bad row
loses the other nine, so **always check `failed`** rather than the status code alone.

The `short_code` in each result is what goes on the sticker. It is **immutable** — renaming it would
break every card already in the world — and the QR must encode the `short_url` as a single
percent-encoding, or it decodes to `https%3A%2F%2F…` and scanning leads nowhere.

#### 3. Attach a location (optional but this is the table you sell)

`public.locations` backs the per-location rollup — "which tables actually convert". Create one per
table or zone:

```bash
curl -s -X POST "$BASE/api/locations" \
  -H "Authorization: Bearer $TOKEN" -H "X-Tenant-Slug: $SLUG" \
  -H "Content-Type: application/json" \
  -d '{"name":"Mesa 1"}'
```

The slug is derived from the name, so `"Mesa Ñoqui"` becomes `mesa-noqui` — accents are folded, not
dropped. Supply one explicitly to override it. A duplicate slug is a `409`, never a silent suffix:
`mesa-1` and `mesa-1-2` are indistinguishable to whoever chooses between them months later.

A location's `slug` is **immutable** (`slug_immutable` on `PATCH`) — it appears on printed material
next to the short code, so renaming it would orphan whatever the designer already produced. Renaming
the `name` and switching `is_active` off are both allowed.

Then attach the links to it, either at creation (`location_id` on each batch item) or afterwards:

```bash
curl -s -X PATCH "$BASE/api/links/<link-id>" \
  -H "Authorization: Bearer $TOKEN" -H "X-Tenant-Slug: $SLUG" \
  -H "Content-Type: application/json" \
  -d '{"location_id":"<location-id>"}'
```

A location belonging to another tenant is rejected with `400`. A valid uuid is not automatically
yours — attaching someone else's would attribute your scans to their numbers.

#### 4. Load the destinations, whenever they are settled

```bash
curl -s -X PATCH "$BASE/api/links/<link-id>" \
  -H "Authorization: Bearer $TOKEN" -H "X-Tenant-Slug: $SLUG" \
  -H "Content-Type: application/json" \
  -d '{"original_url":"https://g.page/<review-id>"}'
```

This invalidates the redirect cache. **Skipping it leaves the sticker serving the previous
destination for up to 24 hours** — the owner pastes the card, the customer scans, and gets the old
target with no error anywhere.

Send `null` or `""` to clear it back to unconfigured. A wrong destination is worse than an absent
one: absent reaches a page that says so, wrong forwards customers somewhere unintended with no signal
at all.

`short_code` cannot be changed — `PATCH` rejects `slug` with `slug_immutable`, including when the
rename rides alongside a valid destination load.

#### 5. Before a card is configured

Scanning a card with no destination serves a **200** page saying the card is real and simply has
nothing behind it yet. Not a 404: a 404 reads as "this product is broken", and the correct response
to that is to abandon the batch. The page shows the `client_ref` and the short code, because that is
how whoever scans it identifies which card is unconfigured.

#### Field reference for these two endpoints

| Field | Create | Update | Notes |
| --- | --- | --- | --- |
| `original_url` | optional | yes, and nullable | A value that is supplied is validated. `null`/`""` clears. |
| `slug` | optional | **rejected** | Immutable once printed. 3–32 chars, `[A-Za-z0-9_-]`. |
| `client_ref` | optional | yes | Max 200 chars, **not** truncated. No uniqueness: N cards may share one. |
| `is_gated` | optional | yes | Must be a boolean. Required for the satisfaction panel to record anything. |
| `location_id` | optional | yes, and nullable | Must belong to the tenant. Backs the per-location rollup. |
| `title` | optional | yes | Max 200 chars. |
| `expires_at` | optional | — | |

### Tenant administration — JWT, no tenant in context

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/tenants` | Create a tenant (registers an owner membership) |
| `DELETE` | `/api/tenants/:id` | Delete a tenant |

These deliberately skip the tenant middleware: a tenant cannot scope itself into context before it
exists, and `DELETE` has to be reachable for a tenant you are trying to leave. Ownership for
`DELETE` is verified inside the handler, not by the middleware.

Deleting a tenant is refused while it still owns links, and while other members hold memberships on
it. `tenants.owner_id` is `ON DELETE RESTRICT`, so deleting the owning Supabase Auth user is
refused rather than silently cascading away a business's data.

### Not in the system

Stated explicitly so the absence reads as a decision rather than an oversight:

- **No self-service billing endpoint.** A customer can read their own status through
  `GET /api/tenants`, but only an operator can change it. See the operator boundary above.
- **No billing webhook.** Payment is off-platform and recorded by an operator. Adding a webhook
  means trusting a third party with the authority to grant service.
- **No endpoint to fetch a single link.** `GET /api/links` plus a client-side filter covers every
  current caller, and a per-link route is a second authorisation surface to keep correct.
- **No pagination.** `GET /api/links` returns the tenant's full set. Fine at the scale this is
  built for; **not** fine at thousands of links per tenant, where it becomes both a latency and a
  memory problem. Add pagination before that, not after.
- **No health-check endpoint.** `GET /` serves as the liveness probe.
- **No rate limiting except `/api/gate`.** Every other route sits behind JWT auth, which is a much
  stronger gate, but it is not a rate limit.

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
public.locations         id, tenant_id (CASCADE), name, slug, is_active, created_at
{tenant}.links           id, original_url (NULLABLE), short_code, title, client_ref,
                         location_id, is_gated, clicks_count, is_active, expires_at,
                         created_at, updated_at
```

`public.short_code_registry` has RLS enabled with **no** policy for `anon`/`authenticated`, so a
browser holding the publishable key cannot enumerate every tenant's short codes in one query.
The Worker connects as the service role and bypasses RLS.

The `{tenant}.links` DDL lives in two places that must stay in sync:
`supabase/migrations/tenant/001_create_links.sql` and the inline template in
`src/tenants/provision.ts`.

Active links are capped per tenant by `MAX_ACTIVE_LINKS` (default `1000` in `src/api/links.ts`,
overridden to `500` in `wrangler.jsonc`). The error message always reports the cap **actually in
force**, so an operator who raised the limit still reads the real number rather than a stale constant.

**Card stock counts against that cap.** `is_active` defaults to `true`, so a link created without a
destination is active from the moment it exists — which is what makes manufacturing cards before their
destinations possible at all. Manufacturing several hundred cards therefore consumes the whole budget
before any of them is configured. Whether the cap *should* count unconfigured links is open; see
`odd/tasks/card-stock-destination-optional-links.md`.

Short codes are random (`nanoid`), not caller-supplied, and never equal a reserved app route. A
caller-supplied `slug` is also accepted for pre-printed tags — see the walkthrough below.

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
pnpm test
```

Vitest runs against the Workers pool. Redirect lifecycle (cache hit and miss), short-code
registry resolution, the reserved-route/router consistency guard, and tracker error handling are
covered. Device-type detection, referrer-source categorization, click-count consistency across
cache paths, and the dashboard handler are not.

There is no CI workflow — `.github/` does not exist. Typecheck and tests run locally only.

## License

MIT

#### The printed card

Geometry, in millimetres, so a designer sets a trim size instead of guessing pixels:

| | |
| --- | --- |
| Card | 85 x 85 mm, rounded corners |
| Module | 1.6 mm |
| Quiet zone | **4 modules** each side (the specification's minimum) |
| Panel | 65.6 mm, centred, 6 mm from the top |
| Short code | outlined, 4.5 mm, baseline 79.9 mm, below the panel |
| Client ref | outlined, 3 mm, baseline 84.2 mm |

Three things this is deliberately not:

- **No `<text>`.** The short code is the fallback for a damaged card — a human
  reads it and types it. As a text element its shape belongs to whoever opens
  the SVG: the designer's Mac, their colleague's Linux box, the print shop's RIP.
  The glyphs are converted to outlines at build time (`scripts/build-glyphs.py`)
  so the Worker does arithmetic rather than shipping a 520 KB font parser.
- **Not one rectangle per module.** Consecutive dark modules merge into a single
  run, with `shape-rendering="crispEdges"`. 564 separate rectangles can show
  hairline seams where the renderer anti-aliases, and a seam through a finder
  pattern is a symbol some scanners refuse.
- **Not a colour.** Pure `#000000` on `#ffffff`, because the press converts to
  K100. The old cream and warm grey were four-colour builds that print grey.

#### Feedback email

`GET`/`PUT /api/tenant/feedback-email` stores the address where a business wants
its private customer comments delivered. It is one column on `public.tenants`, per
business rather than per table: a chain of forty tables must not mean forty
inboxes, and the person who reads reviews is one person.

**It does not send anything.** No provider is wired and the review gate is
untouched, so this cannot break a customer's submission — and a review does not
reach the address yet. Feedback still lands in `analytics.tag_feedback` and shows
in the satisfaction panel, and the dashboard says so next to the field. A green
dashboard next to a label called "feedback email" would otherwise tell an owner
their reviews are being delivered, and they would stop checking the panel.

The address travels in the print sheet's `links.csv` so a print run knows where
its comments are supposed to end up. Wiring a provider (Resend fits Workers
best — native binding, no client library) is a later step, and it needs a retry
or a durable queue: a customer whose review silently vanishes has no way to know,
and neither does the owner.

#### Link and card-stock budgets

Two budgets, counted separately, because a link and a piece of card stock are
different things:

| Variable | Bounds | Default | Counts |
| --- | --- | --- | --- |
| `MAX_ACTIVE_LINKS` | Links **with a destination** | `1000` | Active configured links |
| `MAX_CARD_STOCK` | Links **without** one | `2000` | Active card stock |

`MAX_ACTIVE_LINKS` counts exactly what it always counted, so no existing
deployment loses a link it was able to create. Disabling a link or a card frees
its budget in both buckets.

Card stock is created before its destination exists — that is what makes
manufacturing a sticker possible — and it is active from the moment it is made.
Counting it against `MAX_ACTIVE_LINKS` charged a tenant their whole allowance
for stickers they had not yet printed.
