# Local Business Links — Review Gating, Multi-Location & Subscriptions

**Feature status:** planned (no tasks started)
**Created:** 2026-10-13
**Depends on:** `flat-short-links` (merged, PR #32) — the printable-slug groundwork
**Delivery strategy:** `ask-on-risk` (default)

---

## Objective

Turn the link shortener into the platform a local business buys: a set of **printed links**
(NFC/QR stickers, one per table or zone) that the owner can re-point at any time without
reprinting, that measure per-location traffic, and that filter unhappy customers out of the
public review flow while capturing them privately.

The unit of the product is the link, not the hardware. The hardware is only the acquisition
channel; a customer who understands "I get a URL I can change" does not need to be sold NFC.

## Product

| Product concept | Technical reality |
| --- | --- |
| NFC tag | A link with a caller-chosen slug |
| Pack of 5 stickers | `POST /api/links/batch` with 5 slugs |
| `/r/local-mesa1` | `short_code` + `client_ref` |
| Re-point without reprinting | `PATCH /api/links/:id` |
| Metrics per zone | Group by `client_ref` |
| Gating | **To build** — a link whose scan renders a rating UI instead of a 302 |
| Monthly subscription | **To build** — billing + a status check on the redirect path |

### The action screen — dual path, zero interception

The first draft of this plan gated on sentiment: 4–5 stars to Google, 1–3 to a private form.
That is review gating and it violates Google's review policies. **The gate is removed.**

```
Scan sticker
  └─ GET /:code
       ├─ is_gated = false  → 302 to destination
       └─ is_gated = true   → HTML action screen (fast, mobile, no build step)
              ├─ "Publicar Reseña en Google"  → 302 to the Google review URL
              └─ "Enviar Comentario Privado" → expands inline private feedback form
```

Both options are always visible to every customer. The Google link is never blocked or hidden
based on sentiment. Customers with a minor complaint choose the private channel because it gets
them a direct answer faster, not because they were routed there.

### Optional stars, mandatory action

The star rating is **not** the branch — it is an optional sentiment signal collected alongside
whichever action the customer took. This is strictly better than either earlier version:

| Metric | Derivation |
| --- | --- |
| Derivation rate | `action_taken = 'google_redirect'` / total scans |
| Satisfaction, went to Google | mean rating among `google_redirect` |
| Satisfaction, went private | mean rating among `internal_feedback` |
| **Sentiment gap** | the difference between the two |

The third row is a leading indicator of public review sentiment, and neither the gating version
nor a pure two-button version could produce it. Stars stay optional so the action screen stays
one tap; `action_taken` is the required column.

### The derivation metric (deliberately redefined)

Do **not** measure "reviews published on Google". It is not attributable: the customer leaves
the system and may abandon at steps 3–5 of Google's own flow. Selling it would be selling a
number the system does not control.

Measure instead:

```
derivation rate = scans taking the Google action / total scans
```

Fully derivable from the click event plus `action_taken`, and it is what the owner actually
controls. Every remaining metric is derivable from what the system already stores: scans per
location, action distribution, satisfaction by action, hourly/daily peaks, device, country,
internal feedback count and average rating.

Report delivery is manual (email). No cron, no PDF generator, no WhatsApp API, no per-business
Google OAuth. **Consequence: the dashboard is the document** — what the owner sees on screen is
what they forward, so the dashboard must be presentable as a screenshot.

---

## Verified state of the codebase

Captured 2026-10-13 against `main` at `e8e2998` (PR #32 merged).

### Stack

```
Cloudflare Workers → Hono 4 → pg over Hyperdrive → Postgres (Supabase)
                                       ↑
                              2 KV namespaces
```

Auth is Supabase Auth **validated over HTTP**: `src/middleware/auth.ts:28` calls
`GET ${SUPABASE_URL}/auth/v1/user` on every authenticated request. There is no local
verification, even though `jose` is in `package.json` and `SUPABASE_JWT_SECRET` is declared in
`src/types/env.ts:9`. Both are dead. The README claims "jose verification" and is wrong.

### Printable slugs (already shipped in PR #32)

`src/utils/short-code.ts:124` — `validateCustomSlug`

| Rule | Reason |
| --- | --- |
| 3–32 chars | 32 keeps QR modules small and scannable |
| `[A-Za-z0-9_-]` only | No `/` — it breaks the single-segment route |
| No leading/trailing hyphen | `-foo` reads like a flag |
| Rejects `RESERVED_ROUTES` | Such a link would be permanently unreachable |
| Rejects non-strings | `12345` would silently become a printed label's literal |

The last rule is the subtle one: a caller bug sending `12345` would, without the check, become
the literal printed on a sticker. It fails at creation time, while the labels are still unmade.

### D1/D2 — the attempt budget

In `createLinkCore` the retry budget depends on who chose the code:

- **Caller-supplied slug → ONE attempt.** A collision returns 409 naming the slug.
- **Generated code → `MAX_RETRIES`**, drawing a fresh code each time.

A retry on a supplied slug means a *different* code. That is free when the code was random and
catastrophic when the code is already printed: `.../cafe-central` would resolve to something
else, permanently, with no way to recall the tags.

### Batch creation

`src/api/batch.ts` — `POST /api/links/batch`, `MAX_BATCH_SIZE = 100`. It reuses `createLinkCore`
rather than reimplementing validation, so the two creation paths cannot drift. Returns `201`
when all items succeed, `207` when partial, with `results[]` positionally aligned to the request.

### Configurable cap

`MAX_ACTIVE_LINKS` moved from a constant `= 30` to an env var (`src/types/env.ts:60`). The old
constant was a free-tier number that blocked the real deployment: one link per store, where a
chain of forty locations could not onboard at all. The runaway guard is retained; the operator
sets the number.

### Redirect lifecycle

```
GET /:code
  ├─ resolveRegistryEntry()          src/api/links.ts:113
  │    KV reg:{code} → JOIN registry+tenants → warm cache
  ├─ getCachedUrl(slug, code)        src/cache/shortcode.ts:18
  │    hit  → validate isActive / expiresAt from the JSON blob
  │    miss → SELECT in {schema}.links
  ├─ 302
  └─ waitUntil(trackClick(...))
```

The final step does not block the response. The cost: a Worker evicted mid-request drops the
event. There is no retry and no dead letter.

### Data model

```
public.tenants              id, schema_name, subdomain, salt, is_active, owner_id
public.profiles             id(PK) → auth.users, tenant_id, role(owner|admin|member)
public.short_code_registry  short_code(PK) → tenants.id, link_id      ← RLS, no policies
analytics.link_clicks       tenant_id, link_id, ip_hash, device_type,
                            country_code, referrer, referrer_source, created_at
{tenant}.links              id, original_url, short_code, title, client_ref,
                            clicks_count, is_active, expires_at, timestamps
```

`analytics.link_clicks` carries four indexes. `short_code_registry` has RLS enabled with **zero
policies**, so a browser holding the publishable key cannot enumerate every tenant's short codes.
The Worker connects as service role and bypasses RLS.

**The registry is the isolation boundary.** A failure returns 503; the handler never falls back to
trying another schema. The tenant is resolved from the registry, not from the URL.

### Routes

| Method | Path | Auth |
| --- | --- | --- |
| GET | `/`, `/signup`, `/login`, `/reset-password`, `/auth/callback` | public |
| GET | `/dashboard` | client-side only |
| POST/GET/PATCH/DELETE | `/api/links`, `/api/links/:id` | JWT + tenant |
| GET | `/api/links/:id/clicks` | JWT + tenant |
| POST | `/api/links/batch` | JWT + tenant |
| GET | `/api/clients/metrics` | JWT + tenant |
| POST/DELETE | `/api/tenants`, `/api/tenants/:id` | JWT |
| GET | `/:code` | public — **catch-all, registered last** |

`/dashboard` ships fully rendered HTML to any caller and defers authentication to client-side
Supabase session checks in the browser. There is no server-side protection on that route.

### Provisioning

`src/tenants/provision.ts:85` runs, inside a single `withClient`: generate `tenant_` + 8 random
hex; insert `public.tenants` (the salt comes from a `gen_random_uuid()::text` DEFAULT); insert
`public.profiles`; `CREATE SCHEMA`; run the `links` DDL and four indexes.

The comment at line 72 claims a "single transaction". That is false. `withClient` is only
`connect → fn → end` (`src/db/client.ts:28`); there is no `BEGIN`/`COMMIT`. If the DDL step
fails, a tenant row survives whose schema has no `links` table — inconsistent state, no rollback.

The tenant DDL is duplicated on purpose between `src/tenants/provision.ts:22` and
`supabase/migrations/tenant/001_create_links.sql`, because Workers cannot read files at runtime.
`test/db/schema.test.ts` asserts the two do not drift.

### UI

No React, no Tailwind, no build step. `src/handlers/dashboard.ts` is an HTML string with inline
`<style>` and `supabase-js` from unpkg. The same pattern serves auth, landing and dashboard.

---

## Gaps against the product

| Needed | State |
| --- | --- |
| Legible, stable slug for a sticker | ✅ `validateCustomSlug` |
| Create a pack of N stickers at once | ✅ `POST /api/links/batch` |
| Re-point without reprinting | ✅ `PATCH /api/links/:id` |
| Group by zone | ✅ `client_ref` + `/api/clients/metrics` |
| Tracking with country / device / time | ✅ `analytics.link_clicks` |
| Edge redirect without blocking | ✅ `waitUntil` |
| Tenant isolation | ✅ schema-per-tenant + registry |
| **Action screen + both paths visible** | ❌ absent |
| **`analytics.tag_ratings` / `tag_feedback`** | ❌ absent |
| **`public.tenant_memberships` for multi-site** | ❌ absent |
| **Billing + subscription kill-switch** | ❌ absent |
| **`subscription_status` in the registry JOIN** | ❌ absent — kill-switch depends on it |
| Tests for device-type, referrer, dashboard | ❌ uncovered |
| CI | ❌ absent |

The printable-tag layer is complete. What remains is gating, subscription and multi-location.

---

## Problem

| Gap | Where | Consequence |
| --- | --- | --- |
| A scan is a bare 302 | `src/handlers/redirect.ts` | No moment exists in which to ask the customer how it went |
| No rating anywhere in the schema | `{tenant}.links`, `analytics.link_clicks` | Nothing to gate on and nothing to aggregate |
| One profile per auth user | `public.profiles.id` PRIMARY KEY | A user cannot belong to two tenants, so a 3-site business is 3 separate accounts |
| No billing anywhere | — | No MRR, no way to gate a lapsed customer |
| Auth costs a network hop per request | `src/middleware/auth.ts:28` | Unnecessary latency on every `/api/*` call |
| Provisioning claims a transaction it does not have | `src/tenants/provision.ts:72` | Partial failure leaves a half-provisioned tenant |

### Correction to an earlier claim in this analysis

`public.profiles.tenant_id` is **not** `UNIQUE`. The real constraint is that `profiles.id` is the
PRIMARY KEY and references `auth.users(id)`. The consequences are asymmetric:

- A tenant **may** have many profiles — a business with staff is already supported.
- A user **may not** have many tenants — that is what blocks a multi-site owner.

The fix is therefore on the user→tenant relationship, not on making `tenant_id` unique.

---

## Scope

### In scope

- `locations` table, `links.location_id`, and the auth change that lets one user own one
  business with N sites.
- `is_gated` on the link, the rating UI on the redirect path, and the branch on rating.
- `analytics.tag_ratings` and the internal feedback store.
- Dashboard metrics: rating distribution, derivation rate, per-location, hourly peaks.
- Billing provider integration, subscription status, and its check on the redirect path.

### Out of scope

- Google Business Profile API, OAuth per business, or any "reviews published" metric.
- Automated report delivery: no cron, no PDF, no WhatsApp API. Reports are sent by email.
- Rewriting the UI stack. The rating UI follows the existing HTML-string pattern.
- Changing the redirect, cache or registry mechanics that already work.
- A `locations` table is **not** added to `analytics.*`; it belongs in `public`.

---

## Phases

Reordered from the first draft. Two constraints drive the order:

1. **Ship value first.** Multi-site RBAC is the largest phase and delivers nothing a
   single-site customer can see. It moves behind the product.
2. **The system must stay functional at every commit.** No commit may leave a printed sticker
   broken, an API 500ing, or the test suite red.

### The always-functional contract

Every phase obeys these. They are not aspirations; they are the acceptance gate for each commit.

| Rule | How it is enforced |
| --- | --- |
| Schema changes are additive only | `ADD COLUMN` / `CREATE TABLE IF NOT EXISTS`. No drops, no renames, no type changes to a column with data |
| New columns have defaults | `is_gated BOOLEAN DEFAULT false`, so every existing link keeps behaving exactly as before |
| The redirect path cannot break | Any error in the action screen falls back to a plain 302 to the stored URL. A bug in the new UI must never take down a printed sticker |
| Tests stay green | Baseline is **430 tests / 20 files**, `pnpm run typecheck` clean. A phase is not done until it matches or exceeds it |
| One concern per commit | Each task is its own work-unit commit, so a regression has a bisectable origin |

### Phase 0 — Foundations

No behaviour change. Safe to land first, and T0.1 alone removes a network hop from every
authenticated request.

- [ ] **T0.1** Verify the JWT locally with `jose` HS256 against `SUPABASE_JWT_SECRET`, replacing
      the per-request `fetch` in `src/middleware/auth.ts:28`. Keep the HTTP call as a fallback
      until the local path is verified against a real token, then remove `jose`-unused dead
      weight. A verification failure must still produce the same 401 shape as today.
- [ ] **T0.2** Wrap `provisionTenant` in an explicit `BEGIN` / `COMMIT` / `ROLLBACK` so a DDL
      failure cannot leave a tenant row without its schema. Prefer the real transaction over
      correcting the comment.
- [ ] **T0.3** Rewrite the README: `SUPABASE_JWT_SECRET` not `JWT_SECRET`, no `jose` claim, the
      real analytics limits, and the printable-slug rules. Documentation drift is what makes the
      next engineer trust the wrong thing.

### Phase 1 — Locations (additive only)

Deliberately **not** the RBAC rework. This phase only adds the table and the column, so the
action screen in Phase 2 can carry a real `location_id` foreign key. The multi-site access model
waits for Phase 4.

- [ ] **T1.1** `supabase/migrations/00006_locations.sql` — `public.locations(id, tenant_id →
      public.tenants ON DELETE CASCADE, name, slug, is_active, created_at)`, index on `tenant_id`.
- [ ] **T1.2** Backfill: create one location per existing tenant so no tenant is left without one.
- [ ] **T1.3** Add `location_id UUID` to the tenant `links` DDL in **both**
      `src/tenants/provision.ts:22` and `supabase/migrations/tenant/001_create_links.sql`, plus
      a `00007` ALTER migration for tenants that already exist, following the `00004` pattern.
      **Nullable, no default, existing rows left null** — that is what keeps the change additive.

      *Correction to the first draft of this task:* it specified
      `REFERENCES {schema}.locations`. That is wrong on two counts — `locations` lives in
      `public`, not in the tenant schema, and a constraint earns nothing here. Both objects
      share the tenant's lifecycle and are dropped together by the same CASCADE, while
      `ALTER TABLE ... ADD CONSTRAINT` has no `IF NOT EXISTS` form in PostgreSQL and would
      break the re-runnable ALTER pattern. The FK belongs on `analytics.tag_ratings` in
      Phase 2, which outlives any tenant schema.
- [ ] **T1.4** `GET /api/links` returns `location_id` and `location_name` so the dashboard can
      label rows without a second round trip.

**Not in this phase:** `tenant_memberships`, the `profiles` rework, or the context switcher.
Until Phase 4 lands, one tenant still means one location per account — which is exactly how the
system behaves today.

### Phase 2 — Action screen (the product)

- [ ] **T2.1** `is_gated BOOLEAN DEFAULT false` on the link DDL (both copies). Default `false`
      keeps every existing link on the plain 302 path.
- [ ] **T2.2** `analytics.tag_ratings(id, tenant_id, link_id, location_id, rating NULLABLE,
      action_taken CHECK IN ('google_redirect','internal_feedback') NOT NULL, scanned_at)` with
      indexes on `(tenant_id, scanned_at)` and `(link_id, scanned_at)`. It lives in `analytics.*`,
      not the tenant schema, so the dashboard never touches N schemas.
- [ ] **T2.3** `analytics.tag_feedback(id, tenant_id, link_id, location_id, rating, comment,
      customer_contact, scanned_at)`.
- [ ] **T2.4** In `redirectHandler`, when `is_gated` is true, return the action screen instead of
      a 302. One round trip, both actions visible from first paint, usable on a phone with no
      build step. **Wrap in try/catch and fall back to the plain 302** — see the always-functional
      contract.
- [ ] **T2.5** `POST /api/gate` — records `action_taken` plus an optional rating, returns the next
      view. The Google URL is returned verbatim and never withheld.
- [ ] **T2.6** Record inside `waitUntil` alongside the existing click tracking, so a slow insert
      cannot delay the customer's redirect.
- [ ] **T2.7** The private branch renders an inline feedback form reusing the T2.3 table.
- [ ] **T2.8** Decide where the HTML lives. The spec proposes `src/ui/satisfaction.ts`, a
      directory the repo does not have — every other HTML string lives in `src/handlers/`.
      Either is defensible; pick one and do not mix.

### Phase 3 — Metrics

- [ ] **T3.1** Action distribution and derivation rate from `tag_ratings.action_taken`.
- [ ] **T3.2** Satisfaction split by action, plus the gap between the two. **Always render the
      sample size next to the mean** — stars are optional, so this is computed from a
      self-selected minority and the error bars are wide on a small tenant.
- [ ] **T3.3** Per-location table, reusing the `client_ref` rollup pattern in
      `src/analytics/metrics.ts`.
- [ ] **T3.4** Hourly and daily peaks from `created_at` bucketing.
- [ ] **T3.5** Dashboard layout presentable as a screenshot — it is the email report.

### Phase 4 — Multi-site RBAC

The expensive phase, and the reason it sits here: it delivers nothing a single-site customer can
see, so it must not compete with the product for the first days of delivery.

- [ ] **T4.1** Add `public.tenant_memberships(id, profile_id → public.profiles.id ON DELETE
      CASCADE, tenant_id → public.tenants.id ON DELETE CASCADE, role, created_at, UNIQUE
      (profile_id, tenant_id))`.
- [ ] **T4.2** Decide what `public.profiles` becomes. `tenant_id` is `NOT NULL` today, so the join
      table is inert until that changes. Migrate the column out, expand first and drop later.
- [ ] **T4.3** Reconcile the role vocabulary. `public.profiles.role` is
      `CHECK (role IN ('owner','admin','member'))`; memberships introduce
      `('owner','admin','viewer')`. Two vocabularies mean a membership can never be compared to
      a profile role.
- [ ] **T4.4** Context switcher: `GET /api/tenants` returns every tenant the user can reach, and
      an explicit context selects one per request.
- [ ] **T4.5** Enforce per-store isolation: a membership in tenant A grants nothing in tenant B.

### Phase 5 — Subscriptions

- [ ] **T5.1** Choose the billing provider for the target market. Not yet decided.
- [ ] **T5.2** `subscription_status` on `public.tenants`, with webhook handling. **This column is
      the source of truth** — see the kill-switch design below.
- [ ] **T5.3** Enforce on the redirect path. `is_active` and `subscription_status` mean different
      things and must not be conflated:

| Condition | Meaning | Result |
| --- | --- | --- |
| `is_active = false` | tenant removed / deprovisioned | 404, as today |
| `subscription_status IN ('past_due','canceled')` | customer exists, has not paid | pause page with a reactivate link |

- [ ] **T5.4** Add `subscription_status` to the registry JOIN so it lands in the `reg:{code}` KV
      entry. The join already reads `public.tenants` and already filters `t.is_active = true`, so
      this is one more column on a query that already runs.

#### Kill-switch: KV mirrors the truth, it does not hold it

The intent is a `< 50 ms` paused resolution with no Postgres hit. That is right, and the shape
is correct — but the truth must live in Postgres, with KV as its cache.

**`reg:{code}` has a 24 h TTL** (`SHORT_URL_CACHE`, `SHORT_URL_TTL = 86400`, reused by
`setCachedRegistryEntry`). A kill-switch written only to KV therefore expires, and the next
request falls through to the registry JOIN. If the JOIN does not read `subscription_status`, the
entry comes back clean and **a paused tenant silently resumes serving printed stickers** — a
revenue leak and a broken promise at the same time.

So: `subscription_status` on `public.tenants`, returned by the JOIN, mirrored into the KV entry.
TTL expiry then re-reads the real status instead of resurrecting the old one.

Two cache entries exist per code and only the registry one is involved: `reg:{code}` maps code
to tenant, `{slug}:{code}` holds the destination URL and its `isActive`/`expiresAt`. Gating at
the registry level is the correct layer — it is consulted before the database fallback, so a
paused tenant costs no query.

- [ ] **T5.5** A webhook that flips `subscription_status` writes the new value to every
      `reg:{code}` entry of that tenant in `waitUntil`, so reactivation is immediate worldwide.
      A tenant with many stickers means many KV writes — batch them and tolerate partial failure,
      since T5.4 guarantees correctness even when a write is missed.

## Acceptance criteria

- `GET /:code` for a non-gated link still 302s and records a click.
- `GET /:code` for a gated link renders the action screen in a single round trip, with **both**
  actions visible from first paint.
- The Google review URL is returned to every customer regardless of sentiment, and no code path
  withholds it.
- `action_taken` is recorded for every scan that used the screen; `rating` is optional.
- The private branch stores the feedback and is reachable without a public redirect.
- One business can hold several locations, seen under one account, with per-location isolation.
- A pack of N stickers is created with one batch call, each with its own stable slug.
- A supplied slug that collides returns 409 and never regenerates.
- A tenant whose subscription is `past_due` serves the pause page, **including after the
  `reg:{code}` KV entry expires**.
- Reactivating the subscription restores routing without reprinting or redeploying.
- `pnpm run typecheck` and `pnpm test` stay green.

## Applicable checks

Test-first throughout. Highest-value cases, in order:

1. **Zero interception.** No rating value, and no code path, can withhold the Google URL. This is
   the compliance guarantee; it needs a test that fails loudly if anyone re-adds a branch.
2. **The kill-switch survives TTL expiry.** Force the `reg:{code}` entry to expire and assert the
   tenant is still paused. Without this the failure is silent and costs real revenue.
3. **The supplied-slug collision.** It must 409, never silently regenerate. A regression here
   silently re-points a printed sticker.
4. **Multi-location isolation.** A link from location A must not appear in location B's metrics,
   and a membership in tenant A must not grant access to tenant B.
5. **Provisioning rollback.** A DDL failure inside `provisionTenant` leaves no tenant row behind.

## Risks

### The product claim has to change, not just the implementation

Removing the gate is correct, and it costs the headline. The pitch was "we stop your 1-star
reviews". That product no longer exists — and it should not, because it was never legal.

What the customer actually buys now: a private channel that unhappy customers use voluntarily, a
satisfaction signal per zone, and re-pointing without reprinting. That is a real product, but it
sells on operational insight rather than on fear, and it is a slower sale. A prospect who was
buying insurance against a bad review is not buying this.

Expect the capture rate of private feedback to be materially lower without routing. That is the
cost of compliance and it should be priced for, not discovered after launch.

### Sentiment capture will be sparse

Stars are optional, so most customers will skip them. Satisfaction-by-action is then computed
from a self-selected minority and will have wide error bars on a small tenant. Report it as an
indication, never as a number with false precision, and show the sample size next to the mean.

### Hardware economics: prepay, do not gift

The Trojan Horse model gives the sticker away and bets on retention. At roughly $20.000 CLP of
hardware and $7.990 CLP per month, a customer who leaves after two months costs $20.000 of
hardware for $16.000 of revenue.

The better structure is a setup fee covering the hardware plus three months prepaid: positive
cash on day one, and the prepaid months are earned before the churn risk exists. This is
strictly better than a deposit, which still leaves the customer able to walk during the prepaid
period having paid nothing for it.

The retention hook that actually works is "re-point your Google listing without reprinting". That
ties the service to the business's operating cycle. The dashboard demonstrates the value;
re-pointing retains it.

### The kill-switch is a cache, not a database

Covered under Phase 5. The failure mode is specific and silent: a paused tenant whose `reg:{code}`
entry expires resumes serving printed stickers, because the registry JOIN does not currently
read `subscription_status`. The column has to exist in Postgres before the KV write means
anything.

### Feedback notification channel undecided

Phase 3's T3.3 needs a delivery channel. There is no per-business email today —
`public.tenants` has `owner_id`, not an email column. Options: add one to `public.tenants`, or
resolve it through `public.profiles` → `auth.users`. The second is free and already consistent
with how the tenant is reached today.

### Burst loss in click tracking

`waitUntil` gives the speed the redirect needs and accepts that an evicted Worker drops the
event. Accepted for scans. It must be stated explicitly in whatever the customer is promised,
because the numbers are not exact.

---

## Forecast and delivery

Ordered for speed and for a system that stays live. Sizing against the ~400 authored-changed-lines
budget per work unit.

| Phase | Estimate | Work units | Days | Ships value? |
| --- | --- | --- | --- | --- |
| 0 — foundations | small | 1 | 0.5 | no — but unblocks everything |
| 1 — locations (additive) | small | 1 | 0.5 | no — enables Phase 2 |
| 2 — action screen | large | 2–3 | 1.5–2 | **yes — the product** |
| 3 — metrics | medium | 2 | 1 | yes — sellable proof |
| 4 — multi-site RBAC | large | 3–4 | 2–3 | yes, for chains only |
| 5 — subscriptions | large | 3–4 | 2–3 | yes — MRR |

**Phases 0 through 3 are the "few days" delivery** — roughly four working days — and they cover
everything a single-site customer buys. Phase 4 is where a chain with several stores becomes
possible. Phase 5 turns it into MRR.

Phase 4 moved behind Phase 2 deliberately. It is the largest phase and it delivers nothing a
single-site customer can see, so it must not compete with the product for the first days.

## Open decisions

1. ~~Google policy stance~~ — **resolved.** The gate is removed; both actions are always
   visible. See "The action screen" above.
2. **Where HTML lives** — `src/handlers/` (repo convention) or the proposed `src/ui/`. Blocking
   for T2.4. Not blocking for anything in Phases 0–1.
3. **What `public.profiles` becomes** once `tenant_memberships` exists. Blocking for T4.2, because
   `profiles.tenant_id` is currently `NOT NULL` and the join table is inert until that changes.
   **Not blocking for Phases 0–3.**
4. **Role vocabulary** — `member` or `viewer`, and which table carries it. T4.3.
5. **Billing provider** — not yet chosen. Blocks T5.1 only.
6. **Feedback notification channel** — resolve through `profiles` → `auth.users`, or add an email
   to `public.tenants`.

Nothing on the Phases 0–3 critical path is blocked. Work can start today.

## Progress

- [x] Baseline established 2026-10-13: `pnpm run typecheck` clean, **430 tests / 20 files passing**.
- [x] Differentiator spec integrated; Google policy blocker resolved by removing the gate.
- [x] **Phase 0 — foundations complete.** `438 tests / 20 files`, typecheck clean.
  - T0.1 local HS256 verification via `jose`, with an Auth API fallback on ambiguous failure.
    +6 tests. Deliberately non-regressive: the six pre-existing HTTP tests were left untouched
    and still pass, because they exercise the fallback path.
  - T0.2 explicit `BEGIN` … `COMMIT` in `provisionTenant`, with a best-effort `ROLLBACK` that
    rethrows the original error. +2 tests. Two pre-existing tests had names asserting a
    transaction that did not exist; they now assert the bracket instead.
  - T0.3 README corrected: `SUPABASE_JWT_SECRET`, real auth behaviour, printable-slug rules,
    `/api/links/batch`, `MAX_ACTIVE_LINKS`, and the real analytics limits.
- [x] **Phase 1 — locations complete.** `457 tests / 20 files`, typecheck clean.
  - T1.1 `00006_locations.sql` — `public.locations` with a cascading FK to `public.tenants`,
    an index on `tenant_id`, and a UNIQUE `(tenant_id, slug)` so two businesses may both own
    a "centro".
  - T1.2 The backfill lives in the same migration: one location per existing tenant, named
    after the tenant, guarded by `NOT EXISTS` + `ON CONFLICT` so it is re-runnable.
  - T1.3 `location_id UUID` added to both DDL copies with `idx_links_location`, plus
    `00007_add_location_id_to_tenant_links.sql` for deployed tenants, using the same
    `EXECUTE format` / `to_regclass` pattern as `00004`.
  - T1.4 `GET /api/links` returns `location_id` and `location_name` via a LEFT JOIN.
- [x] **Phase 2 — action screen complete.** `494 tests / 21 files`, typecheck clean.
  - T2.1 `is_gated` in both DDL copies + `00008` ALTER for deployed tenants.
  - T2.2/T2.3 `analytics.tag_ratings` and `analytics.tag_feedback` in `00009`, with real
    foreign keys to `public.locations` — unlike `links.location_id`, these tables live in a
    shared schema and survive the drop of any tenant schema, so the FK guards something real.
  - T2.4 `src/handlers/action-screen.ts`. HTML string with inline styles, matching the repo's
    no-build pattern; the second button uses `<details>` so it needs no JavaScript.
    **T2.8 resolved by convention: `src/handlers/`, not `src/ui/`.**
  - T2.5 `POST /api/gate` — records `action_taken` plus the optional rating, returns the
    destination verbatim or the thanks page. Public by necessity: the person scanning a sticker
    is a customer of the business, not a dashboard user.
  - T2.6 Both writes run inside `waitUntil`, so the customer never waits on a database write to
    reach Google.
  - T2.7 The private branch is the inline form on the screen itself.
- [x] **Phase 3 — metrics: work unit A complete** (queries + endpoint). `547 tests / 25 files`.
  - `src/analytics/review-gate.ts` — action split + derivation rate, per-location rollup,
    hourly peaks.
  - `GET /api/review-gate/metrics` serves all three in ONE response. They describe the same
    scans and the dashboard renders them on one screen; three fetches would let the numbers
    disagree in front of the owner.
  - `MIN_RATED_SAMPLE = 5`. Below it no average is published at all, and the sentiment gap is
    null unless BOTH branches clear the floor. The constant ships in the response so the
    "sample too small" label on the dashboard cannot drift from the rule that produces it.
- [x] **Phase 3 — complete.** `568 tests / 26 files`, typecheck clean.
  - `src/handlers/gate-panel.ts` — the panel as a pure payload-in/HTML-out function, kept out
    of the 800-line `dashboard.ts` so it can be tested and read.
  - **Every helper is nested inside the function**, because it is shipped to the browser via
    `Function.prototype.toString()`. A module-scope reference throws `ReferenceError` in the
    browser while every module test passes — the module scope exists under Vitest and not in a
    `<script>`. `test/handlers/gate-panel.test.ts` rebuilds the function from its own source with
    nothing else in scope, so that failure mode cannot come back.
  - The panel degrades to hidden rather than failing the dashboard: the owner who has not
    activated a gated link has no rows, and failing the whole screen over an empty panel would
    be wrong. The other two fetches stay all-or-nothing.
  - The peak chart is CSS bars, not a charting library — this screen is screenshotted and
    forwarded as the monthly report, and a canvas renders as a blank box in a headless
    screenshot.
- [x] **Volume guard on `POST /api/gate`.** Cloudflare `ratelimits` binding
  (`GATE_LIMITER`), keyed on the short code, 30/min.
  - **Why the code and not the IP**: an IP key punishes the customer. A whole
    restaurant sits behind one carrier-grade NAT, so per-IP limiting blocks real
    people at the exact moment a full room arrives together. `test/handlers/gate.test.ts`
    fails if this is ever reverted to an IP key.
  - **Fails open.** A limiter outage must not take the screen down for real
    customers; the cost is that a flood gets through during the outage.
  - **Junk spends no budget.** The guard sits after validation, so a malformed
    body cannot exhaust a real sticker's allowance; a flood of *well-formed*
    bodies is stopped before Postgres.

  ### Deliberately NOT done — and why

  The derivation rate is computed from `analytics.tag_ratings` for both
  numerator and denominator, and **that table is what the public POST writes**.
  An attacker who inflates one inflates the other. So rate limiting bounds
  volume; it does not make the metric trustworthy. A patient attacker under the
  limit is never slowed down.

  Closing that would mean anchoring the denominator to `analytics.link_clicks`
  (written on the redirect, not the POST) and/or a per-visit HMAC nonce minted
  when the `no-store` action screen renders. The owner chose volume control as
  sufficient for now, and declined the integrity work — recorded here so it is a
  decision rather than an oversight.

  Also considered and **rejected: rotating QR/NFC codes.** A short-lived code
  would break the product's essence — a sticker that is pasted once and works
  for a year becomes a screen to maintain or a monthly reprint. It is also worse
  technically: the QR error-correction level that buys scannability at table
  distance costs ~33% extra width, so a shorter rotating code renders a larger,
  harder-to-scan symbol. Viable only for digital signage, which is a different
  product. Worth revisiting if digital-menu customers ask for it.

- [ ] Phase 4 — multi-site RBAC
- [ ] Phase 5 — subscriptions

## Next step

Phase 1. `public.locations` plus a nullable `location_id` on the tenant `links` DDL — additive
only, with existing rows left null. Nothing in Phase 1 depends on an open decision, and Phase 2
needs the table to exist so `tag_ratings.location_id` can be a real foreign key.
