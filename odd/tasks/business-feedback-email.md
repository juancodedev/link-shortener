# Business feedback email (phase A: store, show, export)

## Objective

Let an owner record the address where their private customer feedback should go,
and see it in the places a print run needs it. **Nothing sends email in this
phase** — Resend is a deliberate later step, not an omission.

## Why

A card carries a QR. The customer scans it, sees the gate, and can leave a
private comment. That comment lands in `analytics.tag_feedback` and appears in
the satisfaction panel. The owner never learns a review exists unless they
remember to open that panel.

They have told us where they want it: an address, entered once, in the place
where they already manage the business. That is this feature.

Phase A makes the address real and visible. It does NOT mail anything, because
mailing is a different piece of work with a different failure mode — see
"Deliberately out of scope".

## The decision this feature encodes

**The address is per TENANT, not per location.**

A location is a table. A tenant is the business. Feedback arrives against a code
(a specific table), but the person who reads reviews is one person: the owner. A
chain of forty tables must not mean forty inboxes, and a wrong answer here is
not recoverable by a migration later — the schema choice is baked into every row.

Per-location would be one more nullable column if it is ever needed.

## Scope

- `public.tenants.feedback_email TEXT NULL`, set by the owner
- `GET`/`PUT /api/tenant/feedback-email`, tenant-scoped like every other route
- A "Feedback email" section in the dashboard, with save + confirmation
- The column in `links.csv`, so a print run knows where its feedback goes
- Migration, provisioning note, README

## Deliberately out of scope

**Sending.** No provider, no API key, no `await` in the gate path.

This is not laziness, it is the failure mode. A customer who writes a review and
whose email silently disappears has no way to know, and neither does the owner —
the panel would say "received" while the message evaporated. Sending correctly
means a retry or a durable queue, and a decision about what the customer sees
when delivery fails. That is a piece of work on its own, and it is easier to do
well when the address is already stored and watched over.

The gate handler is NOT modified in this phase. Nothing about this feature can
break a customer's submission.

## Acceptance

- The dashboard persists the address and says so
- An address that fails to save says so, instead of appearing saved
- A malformed address is refused at the boundary, with a message
- `links.csv` carries it, so a designer hands the run to the right place
- The migration is idempotent and the column is nullable
- A tenant with no address set behaves exactly as before

## Verification

- Tests assert on rendered output and handler behaviour, not on substrings alone
- The migration is applied to production and its effect read back, as with 00015
