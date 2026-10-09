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