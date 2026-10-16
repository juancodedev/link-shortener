# Feedback inbox: read and export what customers actually wrote

## Objective

Let an owner read the private comments customers leave at the review gate, and
take them away as a CSV.

## Why this exists

The comments were being stored all along — `analytics.tag_feedback.comment`. The
panel built earlier answers "how many people were satisfied", which is an
aggregate, and it returns only aggregates. Seven real comments existed in
production with no interface that displayed a single one of them.

Collecting a message and never showing it to anyone is the worst outcome a
feedback feature can have: the customer believed they had been heard, the owner
believed nobody had written anything, and the truth was in a table.

This is also what makes the feedback email worth setting. An address with nothing
to forward is a preference; an inbox gives it something to come from.

## Scope

- `GET /api/review-gate/feedback` — the list, tenant-scoped, filtered and bounded
- `GET /api/review-gate/feedback.csv` — the same data as a download
- A "What customers wrote" section in the dashboard
- A shared CSV writer, because one already exists in the QR sheet and two
  hand-rolled versions will diverge on quoting

## Decisions taken, and why

**CSV as well as the list.** A list alone leaves the owner scrolling a year from
now with no way to take the data anywhere. CSV matches how the rest of this
product already hands things to people: the designer gets a CSV with the print
run, the owner gets a CSV with the responses.

**A GET for the export, not a POST.** The export carries only filters, which
belong in a query string, and a GET is what a download is. It is NOT reachable
by a bare `href`, though: every tenant-scoped route authenticates with an
`Authorization: Bearer` header (`src/middleware/auth.ts`) and selects the tenant
with `X-Tenant-Slug`, and a link carries neither. The dashboard downloads it
through `window.__api` — the same headers every other call uses — into a Blob,
so there is one auth path and nothing hand-written to drift.

**Bounded on both sides.** The list is capped because a dashboard that fetches
four thousand rows is a dashboard nobody opens. The export is capped because the
whole thing is built in memory in a Worker, and an unbounded export is a request
that can take the isolate down. The cap is stated in the response rather than
applied silently: the list says `truncated` in its body, the export says it in
an `X-Truncated` header (a CSV has nowhere else to say it without corrupting the
data). Both fetch one row past the cap, so an inbox of exactly the cap is not
falsely reported as truncated.

**Ordered newest first, always.** An inbox that shows the oldest comment first is
a backlog; a comment from four months ago does not need attention before one from
this morning.

**Every row carries its table.** A comment with no location attached is a
sentence with no context, and the location is the only thing that tells an owner
what to do about it.

**Nothing is deleted and nothing is edited here.** Feedback is a record of what
a customer said at a moment. An inbox that could alter it would stop being
evidence.

## What the data already told us

Seven comments exist; `customer_contact` is empty in all of them. The contact
field is optional and nobody filled it. When a provider is wired, most comments
will be unanswerable — which shapes what phase B has to do, and is why the export
carries the contact column even when it is empty.

## Acceptance

- The owner sees comments with date, rating and the table they came from
- An empty inbox says so, and does not look broken
- A comment containing a comma, a quote or a newline survives the CSV round trip
- One tenant's comments cannot be read or exported by another
- Both the list and the export are bounded, and say so when they truncate
- The export downloads from the dashboard with the same auth as every other call
- Filters are validated before the database: a malformed `location_id` or
  `since` is a 400, never a 500
- A comment that starts like a formula (`=`, `+`, `-`, `@`, tab, CR) opens in a
  spreadsheet as text, not as a formula

## Tasks

Delivery strategy: `ask-on-risk` (default). Forecast is under the ~400 authored
line budget per slice, so one PR is expected.

- [x] **T1 — Backend and tests.** Shared CSV writer with formula-injection
  neutralisation; `GET /api/review-gate/feedback` and `/feedback.csv`; filter
  validation (`location_id` uuid, `since` date → ISO) returning 400 before the
  DB; honest truncation (limit + 1) in the list body and the export's
  `X-Truncated` header; removal of the false "list truncates comments" claim.
  Tests: `test/utils/csv.test.ts`, `test/api/review-gate.test.ts`.
  Route: delegated writer (2+ non-trivial files).
- [x] **T2 — Dashboard UI.** "What customers wrote" section rendered by a pure,
  self-contained `renderFeedbackInbox`, serialised into the dashboard script
  like `renderGatePanel`; HTML-escaped customer text; empty state; truncation
  note; CSV export via `window.__api` + Blob. Tests in `test/handlers`.
  Route: delegated writer (2+ non-trivial files).
- [x] **T3 — Address reliability review findings.** Native review lineage
  `review-8beff90efc750482` approved the feature (medium risk, reliability
  lens) with five non-blocking findings, all fixed:
  - [x] W1 — the dashboard export checks `res.ok` before `res.blob()`; a
    refused export shows "Could not export: …" in the card and downloads
    nothing. `loadFeedbackInbox` checks `res.ok` before rendering. The export
    handler is now a named `exportFeedbackCsv(btn, msg)` so it can be run
    against stubs in a behavioural test.
  - [x] W2 — `links.csv` neutralising formula-like `client_ref` /
    `feedback_email` with a leading `'` is kept on purpose (OWASP CSV
    injection); pinned by a test and explained in `src/api/qr.ts`.
  - [x] W3 — `toFeedbackRow` uses a driver `Date` directly, keeping
    milliseconds; only strings are parsed.
  - [x] S1 — `ORDER BY f.scanned_at DESC, f.id DESC`, a stable order for
    comments in the same instant.
  - [x] S2 — `since` is bounded to years 2000..9999; outside is the existing
    400 `invalid_since`.
  Route: single bounded writer (2+ non-trivial files).

## Progress

- T1: RED observed first (18 failing in csv + review-gate tests), then GREEN.
  `npx tsc --noEmit` clean; `npx vitest run` 37 files / 975 tests passed.
  No lint script exists in `package.json`.

- T1 commit: `bc2df80` — feat(feedback): add feedback inbox endpoints and CSV export.
- T2: RED observed for the renderer (`test/handlers/feedback-inbox.test.ts`
  failed on the missing module), then GREEN. The dashboard wiring tests in
  `test/handlers/dashboard.test.ts` were written alongside the wiring, not
  before it. `npx tsc --noEmit` clean; `npx vitest run` 38 files / 992 tests
  passed. Commit: the `feat(dashboard): show customer feedback inbox with CSV
  export` work unit that follows `bc2df80`.
- T3: RED observed first for W1, W3, S1 and S2 (9 failing in
  `test/handlers/dashboard.test.ts` and `test/api/review-gate.test.ts`), then
  GREEN. W2 is a pin of existing behaviour, so it passed on first run by
  design. `npx tsc --noEmit` clean; `npx vitest run` 38 files / 1003 tests
  passed. Commit: `fix(feedback): harden inbox export and feedback row mapping`.
- Auth finding: `window.__api` sends `Authorization: Bearer <token>` and
  `X-Tenant-Slug`; there is no cookie session. The export therefore downloads
  via `window.__api` + Blob + object URL, and reads `X-Truncated` to tell the
  owner when the file was capped.

## Follow-ups

- **Location filter UI.** The endpoints accept `location_id` and `since`, but
  the dashboard has no locations list loaded to build a picker from (it never
  calls `GET /api/locations`). Adding one is its own small change.
- **Pagination.** The list shows the newest 100 and says so; reading further
  back is the CSV for now.

## Next step

Push and open the PR — the user's decision.
