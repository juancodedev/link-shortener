# Card stock: a link that exists before its destination does

## Objective

Let the owner manufacture physical review cards in advance: create a batch of links that carry **no
destination yet**, hand the designer a print sheet with each link's QR already on it, and load the real
review URL later. Scanning a card that has not been loaded yet must reach a **designed "not configured
yet" page**, not a 404.

## Problem

The product's entire premise is a printed object that outlives the software that made it
(`odd/tasks/local-business-links.md`). But the data model makes that impossible to stage:

**`original_url TEXT NOT NULL`.** A card cannot be manufactured before its destination exists, so the
designer is blocked until every review URL is known — which is exactly the moment when the URLs are
*least* settled.

The workaround people reach for is to invent a placeholder destination and replace it later. That
cannot work here:

- `updateLink` accepts only `is_active`, `title`, `client_ref`. There is **no path to change the
  destination at all** — not even to the placeholder.
- `slug` is explicitly rejected with `slug_immutable`, *"a link's URL is immutable once printed"*.

So today the choice is: print cards only after every URL is final, or print cards whose QR points
somewhere that was never correct.

The second reason this matters: **`is_active` defaults to `true`.** A link with no destination is not
an edge case to be avoided — it is the *normal* state of freshly manufactured card stock, and it is
active from the moment it is created. Today that combination is impossible, and the moment it becomes
possible, every consumer of `original_url` has to decide what a null destination means. The redirect
handler is the one that matters: today it would forward a customer to `null`.

## Why the fix is separable, not a loosening

The instinct is to read this as "relax the constraint". It is not. The product already distinguishes
two things, and this feature keeps the distinction sharp:

| | Immutable | Why |
|---|---|---|
| `short_code` | **yes, forever** | it is what is printed; a rename would break every sticker in the world |
| `original_url` | **editable, until set** | it is what is *behind* the code; nothing physical depends on it |

A sticker never changes. What it points at can be corrected as late as the day before it is pasted.
That is not a loophole in the immutability rule — it is the rule stated correctly, in two halves
instead of one.

## Why the destination-less state gets a designed page

The designer **will** scan a card before any URL is loaded. That is not an edge case; it is the first
thing anyone does. If that scan returns a 404, the correct-looking conclusion is *"the product is
broken"* — and the correct response is to abandon the batch. If it returns a page that says *this card
is real, it is not configured yet, here is who to give the URL to*, the designer concludes the tool
works and finishes the job.

The same page is also the recovery path for a card whose destination was loaded and later found wrong.
That is not hypothetical: destinations rot, and a printed card cannot be reprinted.

## What changes

### 1. A destination becomes optional

`original_url` drops `NOT NULL`, in both copies that define the table:

- `supabase/migrations/tenant/001_create_links.sql` (canonical, for new tenants)
- `TENANT_DDL` in `src/tenants/provision.ts` (inline template, for tenants provisioned at runtime)

`test/db/schema.test.ts` already asserts these two stay in sync, so drift fails the build rather than
production.

`createLinkCore` stops treating a missing destination as an error. When one **is** supplied it is still
validated exactly as before — this change makes the field optional, never unchecked.

### 2. Existing tenants get the ALTER

Per-tenant schemas are **not** auto-migrated; `provision.ts` runs an inline template and nothing reads
`supabase/migrations/tenant/` at runtime. Editing the template reaches only tenants provisioned
afterwards. This is the same trap `00004` documents, on `referrer_source`.

A new migration enumerates `public.tenants` and relaxes the column per schema, following `00004`:
idempotent by construction, quoted identifiers via `format('%I', ...)`, tenants without a `links` table
skipped rather than aborting everyone else's ALTER, and version recorded in each tenant's own
`_migrations`.

### 3. The destination becomes editable

`updateLink` accepts `original_url`, validated through the same `validateUrl` as creation. Empty
string clears it back to the not-configured state, which is what makes a mistaken load recoverable.

`slug` stays rejected. That rejection is load-bearing and its test stays.

### 4. A scan of an unconfigured card reaches a real page

`redirectHandler` branches on a null destination and serves a page built from the site's existing
token layer — the same `--kraft` / `--sticker` / `--ink` vocabulary `dashboard-tokens.md` established —
carrying the tenant's contact and the link's `client_ref`, which is the only thing that identifies
which card is unconfigured.

The card is **active**, so this is a normal 200 render, not an error path. A customer must never see a
stack trace, and a designer must never see a bare 404.

### 5. Later: server-side QR, and the batch panel

Both are in scope for this feature and both are **deliberately not in this slice**:

- **Server-side QR (option A).** A print sheet needs an SVG at any size, and the only code that can
  produce one today is a third-party service. It replaces `api.qrserver.com`, which every card
  currently depends on and which this repo does not control.
- **The batch panel.** `POST /api/links/batch` already exists and already returns `id`, `short_code`
  and `short_url` per item. Once links can exist without a destination, that endpoint answers the
  card-manufacturing question, and the panel is a UI surface over it.

Neither is required for the unconfigured state to be correct, and both are large enough to deserve
their own review.

## Scope

**In:**

- `original_url` optional at the schema level, in both DDL copies, with the migration for existing tenants
- `createLinkCore` and `updateLink` semantics for an absent / edited destination
- The unconfigured-card render, on the site's existing tokens
- Tests that fail against the pre-change code

**Out, stated so it is not mistaken for an oversight:**

- Server-side QR and the print sheet (next slice)
- The batch panel UI (next slice — the endpoint is already sufficient)
- Rotating or expiring QR codes — **rejected in `local-business-links.md:711-717`**, and this feature
  gives no reason to revisit it
- Any change to `slug` immutability
- Analytics: an unconfigured card cannot be clicked *through* to a destination, and its clicks mean
  nothing yet

## Constraints

| Constraint | Consequence |
|---|---|
| `client_ref` has no uniqueness constraint | N cards may share one `client_ref` — this is what makes a batch identifiable as a group, and it needs no change |
| Tenant schemas are not auto-migrated | the ALTER must be a migration, not a template edit alone |
| `TENANT_DDL` and `001_create_links.sql` are guarded for parity | both must change together or the build fails |
| Batch is single-tenant, sequential, capped at 100 | batch creation inherits this unchanged |
| `MAX_ACTIVE_LINKS` counts `is_active` rows | card stock counts against the tenant's active-link budget from the moment it is created |
| Dashboard has one delegated listener and no inline handlers | any new action must join the existing `data-action` switch |

The `MAX_ACTIVE_LINKS` row is a real cost, not a footnote: manufacturing 500 cards of stock consumes
the entire active-link budget before a single one is configured. Whether the limit should count
unconfigured links is **not decided here** and is recorded as open below.

## Tasks

- [ ] **T1** — `original_url` nullable in both DDL copies, plus migration `00015` for existing tenants
- [ ] **T2** — `createLinkCore` accepts a missing destination; a supplied one is still validated
- [ ] **T3** — `updateLink` accepts `original_url`, including clearing it; `slug` stays rejected
- [ ] **T4** — `redirectHandler` serves the designed not-configured page for a null destination
- [ ] **T5** — full suite green, each task verified green on its own tree

## Verification evidence

Populated per task below as each closes.

## Open questions

- **Does `MAX_ACTIVE_LINKS` count unconfigured links?** If yes, card stock competes with working links
  for the budget, and a manufacturer hits the ceiling with nothing live to show for it. Deferred: it
  is a product-policy call about the limit's meaning, not a defect in this feature.
- **Does an unconfigured card count as a click?** Deferred with analytics.
- **Should the not-configured page expose `client_ref` to a member of the public?** It identifies an
  unconfigured card to whoever scans it. It is tenant-scoped and carries no personal data, but it is a
  deliberate exposure and deserves to be an explicit choice rather than an accident.

## Next step after this

Server-side QR, and the print sheet the `copy-print-sheet` button has been promising since T3.4
(`store-links-and-client-refs.md:915-917`).