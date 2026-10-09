# Store Links & Client Identifiers

**Feature status:** Phase 0 complete — Phase 1 complete — Phase 1.5 (stored-XSS fix) complete; all uncommitted, for review. Phase 2+ not started
**Created:** 2026-10-09
**Delivery strategy:** `ask-on-risk` (default)

---

## Objective

Give each short link a **client identifier that the user defines**, so every link can be
correlated with a client record held in an external CRM, and so scans roll up per client.

Right now the user is the only client of this system. They will define an identifier per link
by hand and copy that data into the CRM themselves. **No API is being built now** — an API is a
future extension, explicitly out of scope for this phase.

## Problem

| Gap | Where | Why it blocks the use case |
| --- | --- | --- |
| No client identifier on a link | `supabase/migrations/tenant/001_create_links.sql:7-17` — only `title` and `expires_at` | Nothing to correlate a link with a CRM record |
| No unique visitors | `src/api/links.ts` counted rows; `ip_hash` stored but never used for distinct counting | Footfall is the point. A customer tapping three times is one person, not three visits. |
| Hard cap of 30 active links | `src/api/links.ts:23` (`MAX_ACTIVE_LINKS`) | One link per client blows past 30 immediately |
| Caller-supplied short codes unsupported | `src/api/links.ts:107` generates a random `nanoid` | Cannot pre-generate deterministic URLs for printing on tags |
| Test command could not start | `vitest.config.ts` imported a subpath export removed in `@cloudflare/vitest-pool-workers` 0.16.18 | `npm test` aborted with `Missing "./config"` — no verification was possible at all |

## Scope

### In scope

- A `client_ref` text identifier on `links`, user-defined and user-editable from the dashboard.
- Unique-visitor analytics based on `ip_hash` with a documented time window.
- Parameterized active-link cap.
- Caller-supplied short codes for pre-printed tag URLs.
- Dashboard display of the client identifier alongside the link and its stats.

### Explicitly out of scope

- **A public or server-to-server API.** The user will copy data into the CRM by hand for now.
  A future API is wanted eventually but is not being built in this phase.
- **Storing client data.** Name, contact, and billing live in the CRM. This system stores only
  an identifier the user defines, plus a human-readable label. No second source of truth.
- A full `locations` entity with addresses and per-store CRUD. Deferred — see Deferred.
- City / region / ASN geolocation. Country and device type are enough.
- A UTM campaign model.

### Constraints

- Postgres via `pg` over Hyperdrive. Tenant isolation must not weaken.
- **Dual-DDL hazard:** the `links` DDL lives in two files — `supabase/migrations/tenant/001_create_links.sql`
  and the inline template in `src/tenants/provision.ts`. They must be kept in sync manually.
- **Per-tenant schemas are not auto-migrated.** Editing a migration file helps only NEW tenants.
  Any change to an existing tenant's `links` table needs its own `ALTER TABLE` applied directly.
  This bit us on `referrer_source`.
- IP-based uniqueness is an estimate. NAT and carrier CGNAT collapse distinct people into one
  `ip_hash`. Valid for footfall trends, never for identity.

## Phase 0 — Defect fixes ✅ COMPLETE

Delivered 2026-10-09. All four verified against the codebase, all verified by running the suite.

- [x] **T0.1** Registered `DELETE /api/links/:id` in `src/router.ts:68`. The `deleteLink` handler existed and the dashboard called it, but no route was registered — the delete button was dead. Now returns 200 end-to-end.
- [x] **T0.2** Added `supabase/migrations/00003_add_referrer_source.sql`. The column existed in no migration, so `tracker.ts`'s primary INSERT **always threw** and fell through to a second INSERT on every single click, and the read path always returned a hardcoded `"Direct"`. The dashboard's "By Source" panel was 100% Direct. **This migration must be applied to already-deployed databases.**
- [x] **T0.3** Replaced the `LIMIT 50` sample in `linkClicks` with an unbounded `GROUP BY` aggregate plus a separate recent-N query. Previously `total` capped at 50 *and* all three breakdown widgets were computed from those same ≤50 rows, so every panel was wrong above 50 clicks. Response shape is unchanged and backward-compatible.
- [x] **T0.5** Added `.github/workflows/ci.yml` as a blocking gate. The existing `deploy.yml` was worse than absent: it set `continue-on-error: true` at *both* the job level (line 14) and the test step (line 26), so tests had never blocked a deploy.
- [x] **T0.6** Added regression tests for the >50-row aggregation, the migration's column, and the DELETE route.
- [x] **T0.8** *(added during implementation)* Fixed `vitest.config.ts`, which imported `defineWorkersConfig` from `@cloudflare/vitest-pool-workers/config` — a subpath export that no longer exists in 0.16.18. `npm test` could not start at all. Replaced with the `cloudflareTest()` Vite plugin.
- [x] **T0.9** *(added later)* Resolved the redirect status-code contradiction in favour of **302** and fixed the stale `cache/tenant` mock. Cleared 10 of the 22 pre-existing failures. See below.

### Withdrawn after verification

Two initially-reported defects were investigated and found **not to be defects**. They are
recorded here so nobody re-raises them:

- **`clicks_count` UPDATE matching on `short_code`** — correct as written. `short_code` is uniquely
  indexed per tenant schema, so it identifies the row unambiguously.
- **`tenantSalt: ""` in `src/middleware/tenant.ts:95-96`** — real, but low impact. The redirect path
  uses `redirect.ts`'s own `resolveTenant`, which reads all three fields from KV correctly
  (`cache/tenant.ts:6-10`). The empty salt only affects the API middleware, which does no tracking.

### Known pre-existing failures (22) — RESOLVED PARTIALLY: 10 of 22 fixed, 12 remain

The suite runs now and reports **188 passed / 22 failed**. All 22 were confirmed pre-existing —
verified by re-running the one failure in a touched file (`test/api/links.test.ts > returns 400 for
invalid URL`) against the original unmodified file, where it also fails. They concentrate in
`redirect`, `tenant cache`, `auth`, and `validation` tests, none of which this work touched.

One root cause worth investigating separately: with the installed Hono 4.12.26, `app.use("*")`
middleware no longer observes downstream throws, so `errorHandler` may no longer be mapping
`AppError` subclasses to their HTTP status codes. Unconfirmed — not part of this phase.

#### T0.9 — Redirect status corrected 301 → 302, and the stale tenant-cache mock fixed

**Status: complete.** 10 of the 22 failures cleared. Suite is now **207 passed / 12 failed**.

The system contained a status-code contradiction: `src/handlers/redirect.ts:280` already returned
`c.redirect(redirectUrl!, 302)`, but the spec, the tests, the structured log field, and the handler
docstring all said 301. **The live code was correct; the spec and the tests were wrong.** Resolution
was to align everything to 302 — the handler's `c.redirect` line was not touched.

**Why 302 wins.** A 301 is cached permanently by browsers and CDNs with no TTL and no revocation
mechanism. That makes two requirements this system already has unsatisfiable at the same time:

- the **24h KV TTL** mandated for the short-code cache, and
- **REQ-L003**, which requires that inactive or expired links stop redirecting.

Under 301, deactivating a link would never take effect for any client that had already cached it —
permanently. Under 302 the client re-requests, the Worker re-reads KV, and the lifecycle change
takes effect within the 24h window. Deactivation and expiry are central to the NFC-tag use case,
which is the worst case for 301 because the tag publisher cannot control the scanning client's cache.
The SEO rationale for 301 does not apply: destinations are Google Maps review links and affiliate
links, which are not indexed pages and have no authority to consolidate. Request volume does not
meaningfully increase, since KV already absorbs traffic for 24h and the database is hit only on a
cache miss.

Two distinct root causes were behind the 10 failures, and **only the second one was a test bug**:

1. **Status-code drift (6 assertions).** Six tests asserted `redirectFn` was called with `301` while
   the handler emits `302`. The expected status genuinely changed; those assertions were updated to
   `302` and nothing else about them was altered. No assertion was weakened, skipped, or loosened to
   make a test pass.

2. **Stale `cache/tenant` mock (the actual root cause).** `test/handlers/redirect.test.ts` mocked
   `../../src/cache/tenant` with the legacy `getCachedSchema` / `setCachedSchema` exports, but
   `src/handlers/redirect.ts` imports `getCachedTenant` / `setCachedTenant`. The imported bindings
   were therefore `undefined`, `resolveTenant` threw on invocation, and the handler swallowed the
   throw at `src/handlers/redirect.ts:109-122` into a 503 — so **every** redirect test failed,
   including the 404 and 410 cases that had nothing to do with the status code. The mock now provides
   the exports the module under test actually imports, returning the `CachedTenant` shape
   (`schemaName`, `tenantId`, `tenantSalt`) declared in `src/cache/tenant.ts:6-10`. Note that
   `resolveTenant` treats a cached entry with an empty `tenantId` as incomplete and falls through to
   the database, so the mock returns a populated `tenantId`.

   A third issue surfaced once that was fixed: two "cache hit" tests supplied a KV blob with no
   `linkId`, which `src/handlers/redirect.ts:152-153` deliberately treats as a cache miss to force a
   DB refresh. The fixtures were completed with a `linkId` so they exercise the cache-hit path their
   names claim.

Files changed: `src/handlers/redirect.ts` (log field + docstring only — no behavioural change),
`test/handlers/redirect.test.ts`, `openspec/specs/link-shortener.md` (live spec corrected to 302 with
the reasoning), and amendment notes appended to the two archived files. The archived
`spec.md` and `design.md` bodies were deliberately **not** rewritten: they still say 301, and that is
correct as a historical record. A clearly-marked amendment note at the top of each points to the live
spec.

#### Remaining debt: 12 failures across 7 files

| File | Status |
| --- | --- |
| `test/utils/validation.test.ts` | **CLOSED** — URL normalization resolved; see below |
| `test/middleware/auth.test.ts` | 4 unhandled rejections: `Invalid URL: undefined/auth/v1/user` |
| `test/cache/tenant.test.ts` | Not touched — out of scope for this fix |
| `test/middleware/tenant.test.ts` | Not touched — out of scope for this fix |
| `test/api/tenants.test.ts` | Not touched — out of scope for this fix |
| `test/api/links.test.ts` | **CLOSED** — its `returns 400 for invalid URL` test passed once `validateUrl` rejected the protocol-less input; no edit was needed |
| `test/handlers/landing.test.ts` | Not touched — out of scope for this fix |

#### Resolved: URL normalization must not auto-prepend a protocol

`validateUrl` used to prepend `https://` to any input lacking `://`. Two defects
followed. `javascript:` and `data:` carry no `//`, so they were rewritten to
`https://javascript:alert(1)` and rejected by a *parser* failure — the protocol
allowlist was unreachable for exactly the payloads it exists to stop. And any
string without `://` was promoted to a trusted host: `//evil.com` became
`https://evil.com/`, so `not-a-url` and `google.com/maps` validated as URLs.

Scheme detection (RFC 3986 `ALPHA *( ALPHA / DIGIT / "+" / "-" / "." ) ":"`,
anchored, independent of `//`) now runs before parsing. No scheme is
`invalid_url`; a scheme outside http/https is `invalid_protocol`. An explicit
protocol is now mandatory — `google.com/maps/place/foo` is rejected and users
must write `https://`. The blocked-host, private-IP and length checks are
unchanged.

Known gap left open, deliberately: `isPrivateIPv4` covers RFC 1918 only
(10/8, 172.16/12, 192.168/16), so the link-local range — including the cloud
metadata endpoint `169.254.169.254` — is still accepted. That predates this
change and closing it would alter a check this task scoped as unchanged.

## Phase 1 — Client identifier

- [x] **T1.1** Add `client_ref TEXT` to the `links` table (nullable, indexed).
- [x] **T1.2** Mirror it in the `src/tenants/provision.ts` template so new tenants get it.
- [x] **T1.3** Write an `ALTER TABLE` migration for **existing** tenant schemas — editing the
  template does not touch them.
- [x] **T1.4** Accept `client_ref` on link create and update in `src/api/links.ts`.
- [x] **T1.5** Dashboard: editable client identifier field on each link, shown in the links table.

## Phase 2 — Unique visitors

- [ ] **T2.1** Define and document the semantics: distinct `ip_hash` per link per rolling window
  (daily default). Record the IP-estimate caveat where the metric is displayed, not only in docs.
- [ ] **T2.2** Expose unique visitors from `linkClicks` via `COUNT(DISTINCT ip_hash)`, alongside
  the now-accurate `total` from Phase 0.
- [ ] **T2.3** Roll up unique visitors per `client_ref`.
- [ ] **T2.4** Dashboard: unique visitors next to total clicks.
- [ ] **T2.5** Tests, including the >50-row case that previously broke aggregation.

## Phase 3 — Links at physical scale

- [ ] **T3.1** Replace `MAX_ACTIVE_LINKS = 30` with a limit that accommodates one link per client.
- [ ] **T3.2** Accept a caller-supplied `slug` on link creation, with validation and collision
  handling, so tag URLs can be pre-generated and printed.
- [ ] **T3.3** Batch-create links in one request to onboard many clients at once.

## Deferred

- A `locations` entity with address and per-store CRUD. Only if per-client grouping outgrows the
  flat `client_ref` field.
- Query-param passthrough for campaign attribution.
- The Hono `errorHandler` status-code mapping question raised in Phase 0.
- A public API for CRM integration. Wanted eventually; not in this phase.

## Acceptance criteria

- A link carries a client identifier the user defines, editable and visible in the dashboard.
- Scans and unique visitors roll up per client identifier.
- Unique visitors are reported distinctly from raw clicks.
- `total` and all breakdown panels are accurate above 50 clicks.
- The active-link cap no longer blocks a one-link-per-client deployment.
- CI blocks on typecheck and tests.

## Applicable checks

After every task: `npm run typecheck` and `npm test`. Both now run.

Test-first applies to Phase 2 (clear observable semantics) and to any Phase 1 endpoint change.
Phase 1 schema work is verified by migration tests plus the existing suite staying green.

## Progress

Phase 0 delivered and verified 2026-10-09. T0.9 (redirect 301 → 302 and the stale `cache/tenant`
mock) completed 2026-10-09. Nothing is committed — all work sits uncommitted in the working tree for
review.

Suite state: **207 passed, 12 failed** (was 188 passed, 22 failed; T0.9 cleared 10). The 12 remaining
are listed in "Remaining debt" above and belong to other work. Note that `npm test` reports 4
unhandled rejections in `test/middleware/auth.test.ts` (`Invalid URL: undefined/auth/v1/user`) in
addition to the counted failures; those were present before this change and remain.

### Phase 1 delivered 2026-10-09

All five tasks complete, uncommitted, for review. Suite is **237 passed / 12 failed** — the same 12
pre-existing failures, **zero new**. `npm run typecheck` is clean.

Files added/changed: `supabase/migrations/tenant/001_create_links.sql`, `src/tenants/provision.ts`,
`supabase/migrations/00004_add_client_ref_to_tenant_links.sql` (new), `src/api/links.ts`,
`src/handlers/dashboard.ts`, `test/api/links.test.ts`, `test/db/schema.test.ts`.

**T1.3 — how existing tenants get the column.** There was no precedent: the repo had only ever
backfilled the shared `analytics` schema, never a per-tenant one. Two findings shaped the answer:

1. **Nothing reads `supabase/migrations/tenant/` at runtime.** `provision.ts` carries the DDL inline
   because Workers cannot read files. That directory is a *reference copy*, not an execution path.
   So dropping a `002_add_client_ref.sql` there would have been decorative — it would look like a
   migration and migrate nothing.
2. **Per-tenant schema names are generated at provision time** (`tenant_` + 8 hex), so no migration
   can hardcode one.

`00004_add_client_ref_to_tenant_links.sql` therefore enumerates `public.tenants` and runs the
statement per schema inside a `DO` block via `EXECUTE format(..., %I)`. It is idempotent:
`ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, and it `CONTINUE`s past any registry row
whose `links` table is absent so one bad row cannot abort the loop for every other tenant. Each
tenant records version 2 in its own `_migrations`; the run is also recorded in `public._migrations`.
**This migration must be applied to already-deployed databases** — same caveat as `referrer_source`.

**T1.4 — length limit: yes, 200 characters, rejected not truncated.** `title` is capped at 200 too,
but silently *sliced*, which is harmless for a display label. `client_ref` is an identifier the user
copies into an external CRM: truncating it would store a value that no longer equals what they typed,
and the correlation would silently fail to match. So over-long values are rejected with the existing
`ValidationError` on **both** create and update. Note the asymmetry is deliberate — `title` is only
capped on update, a pre-existing gap left untouched.

**T1.4 — clearing.** `PATCH` accepts `null` as an explicit "unset" so the dashboard input can be
emptied; an emptied field sends `null` rather than `""`, since an empty string would never match a
CRM record. Every other non-string (number, object, array, boolean) is still a 400.

**T1.5 — escaping: the assumed pattern did not exist.** The task brief said to match how the
dashboard already escapes `title` and `original_url`. It does not escape them — **nothing in `src/`
escapes anything**; there is no `escapeHtml` anywhere in the codebase, and `title` is not even
rendered in the links table. The links table is built by assigning a template string to
`tbody.innerHTML`, so `original_url` and `short_code` are interpolated raw today. Rather than
propagate that, a local `esc()` helper was added and used for `client_ref` in both the input's
`value` attribute and its displayed text, verified to neutralise `"><img src=x onerror=...>`.

**This is now inconsistent by construction, and deliberately so:** `client_ref` is escaped, the
pre-existing fields next to it are not. Closing that gap means touching `original_url` and
`short_code` rendering, which is outside this slice. Tracked as follow-up debt below.

**New follow-up debt from Phase 1:**

- ~~`original_url` and `short_code` are interpolated into `tbody.innerHTML` unescaped. Stored XSS if a
  link title/URL ever contains markup.~~ **CLOSED in Phase 1.5** — see below.
- The create-link form has no `client_ref` input; it is settable only after creation, via the table.

## Phase 1.5 — Stored XSS in the dashboard ✅ COMPLETE

Delivered 2026-10-09, uncommitted, for review. This closes the debt Phase 1 explicitly deferred, and
it turned out to be **two distinct defects, not one**. Fixing the wrong one would have looked correct
and left the site exploitable.

### The two classes, and why they need different fixes

**Class A — HTML context.** `original_url`, `short_code`, and `clicks_count` were interpolated raw
into the string assigned to `tbody.innerHTML`. Fixed by routing every interpolated field through the
existing `esc()` helper. Straightforward.

**Class B — JavaScript context. Escaping does not fix this.** The same rows also carried inline
`onclick="..."` handlers with record data interpolated into them. The HTML parser hands an event
handler attribute body to the **JS engine**, not to the HTML parser — so `&quot;` and `&#39;` are
just ordinary characters there and terminate nothing. A `short_code` of `');alert(1)//` closes the
argument list and executes regardless of how well it is escaped.

That is the trap in this bug: applying `esc()` to those attributes produces code that *reads*
remediated and passes an eyeball review while remaining fully exploitable. The only real fix is to
keep user data out of source text.

**What was done instead of escaping:** the inline handlers were deleted and replaced with one
delegated listener on `#links-body`, which reads what it needs from `data-*` attributes via
`dataset`. `copyUrl`, `showQR`, `toggleLink`, `saveClientRef`, `showMetrics`, and `deleteLink` all
keep their original signatures; only the call sites moved. `#links-body` is the right anchor because
`loadLinks` replaces its `innerHTML` and never the element itself, so one listener survives every
re-render.

Note `encodeURIComponent` on the QR button was *not* a defence: it was applied inside a JS string
literal, so it only altered the payload, it did not contain it.

### Also fixed

- The three metric breakdown renderers and the `err.message` error render assigned `innerHTML` from
  API response data. `referrer_source` and `country_code` originate from request headers, so a
  Referer can carry arbitrary attacker-chosen text. Now escaped through `esc()`.
- The `esc()` comment claimed `client_ref` was the only escaped field. Corrected.

### Behaviour preserved

Copy-to-clipboard with its "Copied!" feedback and `dataset.code` restore, the QR modal, toggle
active/inactive, delete confirmation, the metrics expander, and the `esc()`-based null handling. The
QR round-trip (`encodeURIComponent` on entry, `decodeURIComponent` in `showQR`) was kept verbatim
rather than "cleaned up", since it is load-bearing for the displayed label.

### Verification

`test/handlers/dashboard.test.ts` is new. The server never renders a row — the client does — so the
tests **extract the row template out of the served HTML and execute it**, rather than asserting
against a hand-copied copy that would pass while the shipped code stayed vulnerable. Three
assertions were mutation-checked: reintroducing the raw `original_url` interpolation and a single
inline `onclick` each made the suite fail, so the guards are not vacuous.

One assertion was initially wrong and was corrected: asserting the literal string `onerror=` is
absent would be asserting an escaping artifact — the payload legitimately survives as inert escaped
text. The invariant that matters is that no `<` reaches the output, so no element is created.

`src/handlers/landing.ts` was inspected and needed **no change**: it interpolates only deployment
config (`SUPABASE_URL`, `SUPABASE_ANON_KEY`) and no request-scoped or stored data. It has no inline
handlers and no `innerHTML` assignment. This is now asserted by a test rather than assumed.

## Next step

Start Phase 2 (unique visitors). T2.3 rolls up per `client_ref` and depends on
`idx_links_client_ref`, which now exists in both the new-tenant DDL and the existing-tenant ALTER.
Apply `00004` to deployed databases before relying on per-client rollups.
---

# Phase 2 — Unique visitors (appended 2026-10-09)

## Status

**COMPLETE** — all six tasks delivered, uncommitted, for review. Suite is **373 passed / 0 failed**
(was 322 before Phase 2; +38 for Phase 2 itself and +15 for the `listLinks` contract correction,
zero pre-existing failures reintroduced). `npm run typecheck` clean.

## The problem this solves

`analytics.link_clicks` stores raw taps. Someone touching a tag three times counts as three
visits. For measuring footfall to a physical store — the entire NFC/QR use case — raw taps are
meaningless.

## What the data allows

`ip_hash` is `SHA-256(ip + per-tenant salt)` (`src/utils/ip-hash.ts`). That gives a **stable,
deterministic** per-tenant identifier: the same person scanning tomorrow produces the same hash.
No cookie and no consent banner are involved. `COUNT(DISTINCT ip_hash)` is viable.

It is also a **persistent pseudonymous identifier**. Fine for counting, but it must never be
exposed to a client or joined against another dataset — the hash outlives the individual click.

## The ceiling: NAT and CGNAT

Unique-by-hash is a **pessimistic lower bound**:

- a café on shared Wi-Fi sends 40 people through one public IP → the count says 1
- a mobile customer behind carrier CGNAT may share an IP with many other subscribers

## Metric decision

Offer **both**, because they answer different questions:

- **unique_visitors** — `COUNT(DISTINCT ip_hash)` over a rolling window. Daily by default.
  Undercounts shared-IP populations. This is the "how many people came back" figure.
- **sessions** — distinct `ip_hash` per window of **30 minutes**. A person scanning three times
  in a row is one visit, not three. This tracks a real store far better than a daily unique,
  because a lunch rush genuinely is ~30 distinct people rather than 1.

Neither is exact. Both must be labelled as estimates **in the UI**, not only in the docs — a
number called "unique visitors" with no caveat is worse than no number.

## Scope

### In scope

- `unique_visitors` and `sessions` in `linkClicks`, computed in SQL alongside the existing
  accurate `total` and `by_*` breakdowns.
- Both figures rolled up per `client_ref`, since that is the per-store identifier.
- Dashboard display with the estimate caveat visible next to the numbers.
- The window parameters (daily, 30-minute) as named constants, not magic numbers.

### Out of scope

- Cookies, consent banners, or any first-party identifier — none are needed and none should be
  added for this metric.
- City/region/ASN geolocation. Country and device are enough.
- Storing an aggregate table or any denormalized counter. Compute on read; the click volume per
  link does not justify it yet.
- Changing how clicks are recorded.

## Tasks

- [x] **T2.1** `UNIQUE_WINDOW` and `SESSION_WINDOW` named constants in `src/analytics/metrics.ts`,
      with the NAT caveat explained at the point of definition. See "Where the caveat lives".
- [x] **T2.2** Both metrics computed in SQL in `linkClicks`, filtered per `link_id`. One
      aggregate, no `LIMIT`, no folding in JavaScript. See "How the 30-minute window works".
- [x] **T2.3** Both returned alongside `total`, `by_country`, `by_device`, `by_source`, `recent`,
      plus `unique_window` / `session_window` so a label cannot drift from the SQL. Existing keys
      unchanged.
- [x] **T2.4** Per-`client_ref` rollup, on its own endpoint `GET /api/clients/metrics`.
      See "The correction: the rollup's own endpoint".
- [x] **T2.5** Dashboard: both figures per link, plus a store-level rollup card, with the caveat
      in the rendered markup.
- [x] **T2.6** Tests, mutation-checked. See "Verification".

---

## Implementation notes

### How the 30-minute window works

Both figures read **one** de-duplicated derived table:

```sql
SELECT COUNT(DISTINCT s.ip_hash)::int AS unique_visitors,
       COUNT(*)::int                 AS sessions
  FROM (
    SELECT DISTINCT c.ip_hash,
           (floor(extract(epoch FROM c.created_at)
                  / extract(epoch FROM CAST($3 AS interval)))
            * extract(epoch FROM CAST($3 AS interval)))::bigint AS session_bucket
      FROM analytics.link_clicks c
     WHERE c.link_id = $1
       AND c.created_at >= NOW() - CAST($2 AS interval)
       AND c.ip_hash IS NOT NULL
  ) s
```

The pair `(ip_hash, bucket)` is what collapses. `COUNT(DISTINCT ip_hash)` over it is the daily
unique; `COUNT(*)` over it is the session count, because each surviving row is one person in one
half hour — a second and third tap inside the same bucket deduplicate onto the row the first one
already produced.

Four decisions worth recording:

1. **Epoch division, not `date_bin()`.** `date_bin()` needs PostgreSQL 14+, and the deployed major
   version cannot be verified from this repository, so using it would be an unverifiable
   dependency for no gain. Epoch division is exact on every version.
2. **Fixed-width epoch buckets are UTC-anchored.** A `to_char()` / `date_trunc()` string bucket
   would drift with the session time zone and stop meaning anything between two requests.
3. **`floor`, not `round`** — the window is half-open `[k, k+1)`. A click landing exactly on a
   30-minute boundary joins the *later* bucket, i.e. falls outside the earlier one. At that
   instant the person is demonstrably still on site, so the window should still be open.
4. **`ip_hash IS NOT NULL` is load-bearing, not decorative.** `COUNT(DISTINCT)` already drops
   nulls, but `sessions` is a `COUNT(*)`: without the filter a click with no resolvable IP would
   be counted as a person walking in.

Both windows are **bound parameters**, never interpolated. `$3` appears twice in the expression
(as divisor and multiplier) and the two queries bind at different positions — hardcoding the
placeholder produced an unbound `$3` in the rollup, which typecheck and the unit tests both
passed over and Postgres would have rejected at execution time. A test now asserts that every
placeholder a query references has a bound parameter.

### Why the rollup is a second query and not arithmetic

`client_ref` is the per-store identifier, so the store view is the whole point of the feature. A
person who scans two tags in one shop is **one** visitor there, not two — only a distinct count
across every link sharing the ref knows that, so the rollup cannot be assembled by summing the
per-link figures in JavaScript. It also reuses the same `(visitor, bucket)` dedup, so a shopper
who scans both tags inside one half hour is one *session* for the store.

Tenant isolation is inherited from the inner join against the tenant's own links table:
`analytics.link_clicks.link_id` has no foreign key, so that join **is** the boundary — the same
one `linkClicks` already relies on.

### Where the caveat lives

`VISITOR_ESTIMATE_CAVEAT` is exported from `src/analytics/metrics.ts`, next to the window
constants it qualifies. That definition plus three interpolation sites in the served dashboard
markup is four places the sentence lives, and all four survive the `listLinks` correction:

1. **Static server-rendered note** above the links table — visible on page load, before any
   script runs and before anything is expanded.
2. **Inside every link's metrics panel**, next to the two figures — for someone who expands a row
   without scrolling back up.
3. **On the store-level rollup card.**

One exported string, three render points in the markup plus the definition itself, so the sentence
cannot drift from the numbers. The tests assert against the static region of the served page
specifically, not the whole document — an earlier version of that assertion passed while the static
copy was deleted, because the string also occurs inside the inline script.

### The correction: the rollup's own endpoint

Phase 2 shipped `listLinks` returning `{ links, clients }` instead of the bare array it had always
returned. That was a breaking API contract change nobody asked for, taken only because
`src/router.ts` sat outside the edit surface this slice was allowed to touch — a new handler could
not be registered, so the rollup had to ride along inside an existing response. **That constraint is
gone, and so is the deviation.**

The "risk is close to zero" reasoning recorded here was wrong, and wrong in a specific way: the
dashboard kept working *because it was rewritten in the same change*, which is exactly what hid the
breakage from every other caller. The single current consumer passing its own tests is not evidence
that the shape is safe — it is evidence that there is no second consumer yet. This project is
explicitly heading toward a CRM integration that will call this endpoint.

What it is now:

| | |
| --- | --- |
| `GET /api/links` | **Bare array of links**, exactly as before Phase 2. Per-link fields unchanged (`client_ref` present/null, flat `short_url`, `clicks_count`, `is_active`, `expires_at`, `created_at`, `updated_at`). Only the container moved back. The rollup query is gone from it. |
| `GET /api/clients/metrics` | New. Returns a **bare array** of `{ client_ref, unique_visitors, sessions }`. Same SQL, same bind parameters, same windows, same `ip_hash IS NOT NULL` filter — moved, not redesigned. |

Handler `listClientRefMetrics` in `src/api/clients.ts`, registered in `src/router.ts` with the same
`auth` → `userProfileTenantMiddleware` chain as every other tenant-scoped route. That chain is
load-bearing, not decorative: the tenant in context is what qualifies the links table the rollup
joins against, so omitting it would read across tenants.

Why `/api/clients/metrics` and not `/api/clients`: `client_ref` is free text the user types. There is
no client entity in this system, so a bare `/api/clients` would advertise a CRUD resource that does
not exist. The export keeps `client_ref` in its name for the same reason.

Why the response is a bare array rather than an envelope: an envelope is the exact mistake being
corrected, and repeating it on the new endpoint would double it. The trade-off is recorded rather
than hidden — unlike `linkClicks`, this response does **not** ship `unique_window` / `session_window`
next to the figures. That is safe here specifically because the dashboard renders no window label on
this table, whereas `linkClicks` ships them because it does.

The dashboard now issues two fetches in parallel (`/api/links` and `/api/clients/metrics`) inside
the existing `loadLinks`. Behaviour is unchanged, including the all-or-nothing failure path: a
failure in either request shows the same error state rather than a half-rendered dashboard. A
non-array `/api/links` payload is treated as a contract violation and surfaced, not silently
rendered as "you have no links".

**The rule this establishes:** a field is added to a collection by adding it to each element, never
by wrapping the collection. Two collection endpoints can be cached and versioned independently; one
endpoint cannot change shape without breaking half its consumers. `test/api/links.test.ts` now
asserts the bare array structurally (`Array.isArray`, and no `links` / `clients` property) rather
than by snapshot, so a future change cannot reintroduce an envelope by adding a field and
re-baselining an expectation.

### Deliberately not defensive: no try/catch on either new query

The `referrer_source` aggregate has a fallback because the column may be absent on an
already-deployed database, and degrading a breakdown is harmless. Neither new query has that
drift risk, and a silent catch would publish `unique_visitors: 0` for a store that was busy — a
confident "nobody came in today" that is a lie. An error is honest; a wrong zero is not.

### Verification

`npm run typecheck` clean. `npm test` → **373 passed / 0 failed** across 19 files.

The two decisive cases were written before the implementation and observed failing (RED): the
session collapse (`unique_visitors: 1, sessions: 1` from three taps) and the shared-IP scenario
(`total: 40, unique_visitors: 1`), both failing because the fields did not yet exist.

The `listLinks` contract guard was also test-first. Four assertions were written against the wrapped
shape and observed RED — `Array.isArray(body)` returned `false`, the on-wire payload parsed as
`{ clients, links }`, the empty case returned an object instead of `[]`, and the endpoint was issuing
two queries instead of one. Two mutations were then applied and reverted to confirm the new guards
are not vacuous:

| Mutation | Caught by |
| --- | --- |
| `listLinks` response re-wrapped as `{ links }` | `returns a bare JSON array, not an envelope object` (+2 more) |
| `listClientRefMetrics` response re-wrapped as `{ clients }` | `returns visitors per client_ref as a bare array` (+4 more) |
| `userProfileTenantMiddleware` dropped from the new route | `registers it with auth and the tenant middleware` + `routes GET /api/clients/metrics through to the rollup handler` |

The middleware mutation is the one worth keeping: with the tenant middleware removed, the request
does not merely return the wrong numbers, it throws on `c.get("tenant")` being undefined and comes
back a 500.

Eight mutations were applied and reverted to prove the guards are not vacuous:

| Mutation | Caught by |
| --- | --- |
| `ip_hash` dropped from the DISTINCT projection (sessions becomes total) | `de-duplicates on the (visitor, bucket) PAIR` |
| `floor` → `round` in the bucket expression | `buckets on floor() so a click on the boundary joins the LATER window` |
| Static caveat replaced with "Estimates only." | `serves the caveat as static markup` + `states the actual limitation` |
| Per-row caveat replaced with "Approximate." | `repeats the caveat inside each link's metrics panel` |
| Clients-card caveat replaced with "Approximate." | `shows the store-level rollup behind the same caveat` |
| `?? 0` fallback dropped from `renderVisitors` | `reports zero rather than undefined` |
| Sessions demoted to a footnote class (hierarchy reintroduced) | `gives the two figures identical markup` |
| `esc()` dropped from `client_ref` in `renderClients` | `escapes client_ref, which is user-supplied free text` |

The shared-IP test asserts the **undercount** (`total: 40`, `unique_visitors: 1`) with a comment
stating that the system does not solve NAT, so nobody later reads a green suite as evidence that
it does.

## Acceptance criteria

- [x] Both metrics are computed in SQL and returned by `linkClicks`.
- [x] A session window genuinely collapses repeat taps within 30 minutes.
- [x] The dashboard labels both numbers as estimates, in the rendered markup.
- [x] `npm run typecheck` and `npm test` stay green (322 → 360 → 373, zero failures).
- [x] `GET /api/links` returns a bare array again, with a structural regression guard against re-wrapping.

## Applicable checks

Test-first throughout, with one honest exception recorded below.

The API layer (T2.1–T2.4) was written test-first: 18 assertions were observed failing before
any implementation existed. The dashboard markup (T2.5) was written before its tests, so its
guards were established by the eight-mutation check above instead. The net position is the same —
every guard is demonstrably non-vacuous — but the ordering was not strict for the dashboard.

## Next step

Phase 3 — links at physical scale: the `MAX_ACTIVE_LINKS = 30` cap, caller-supplied short codes
for pre-printed tags, and batch creation.

Two things to confirm before relying on this in production:

- **`ip_hash` NULL rate.** A deployment behind a proxy that strips the client IP would report
  `unique_visitors: 0` while `total` climbs. The NULL filter makes the figures honest rather
  than inflated, but the ratio is worth watching.
- **PostgreSQL version.** The epoch-division bucket works on every version, so nothing to verify
  — noted only because `date_bin()` was the obvious alternative and was rejected on exactly this
  ground.
