# Printed cards keep a date, so Links can say "Printed"

Objective: `Mark as printed` records the print run instead of only emptying a page-local list, and the Links table shows an `Printed` badge on a card that was printed. Printing again stays possible.
Branch: `feat/printed-cards-state` · Delivery: one PR, one commit per work unit · Runner: `pnpm test` (vitest), `pnpm exec tsc --noEmit`, `pnpm exec tsc --noEmit -p web`.

## Specs

- **S1 — What the button does today, and what it should do.** "que es lo que hace el boton Mark as printed, se supone que al marcar eso, deberia no permitirme \"Send to print\", en la vista /dashboard#links, ahi deberia indica algo como impresas". `Mark as printed` records the run: every link in the queue gets `printed_at = NOW()`. The local queue empties only after the request succeeds.
- **S2 — Informative, not blocking (option B).** "si, vamos con la B" — the state is persisted and shown, but printing is never blocked: a card gets lost, torn, or ruined in the cutter, so a link that was printed can be sent to print again, and doing so updates `printed_at`.
- **S3 — The queue stays page state.** "la idea antes del tema del patch, era que eso consumia mucho recurso en la pagina, ahora se esa migrando a react y con react, deberia funcionar mejor el manejo de estados". Clicking `Send to print` remains local and synchronous: zero requests per click. Persistence costs **one** request per print run, never one per card.
- **S4 — What Links shows.** On an unconfigured link that was printed, the row shows a `Printed` badge with the timestamp in its `title`. When the link is queued for another run, the `To print` badge wins: the pending action is the one that matters.
- **S5 — Schema.** Migration `00020_printed_at.sql` adds a nullable `printed_at TIMESTAMPTZ` to every existing tenant's `links` table (tenant version 6) and records public version 20. No backfill, no changes to existing columns or rows. `TENANT_DDL` and `supabase/migrations/tenant/001_create_links.sql` both carry it, so new tenants are born with it.

## Tasks

| ID | Specs | Route | Risk | Status | Commit |
|----|-------|-------|------|--------|--------|
| T1 | S5 | inline | item 1 (migration on every tenant schema) | pending | — |
| T2 | S1, S2, S3 | inline | — | pending | — |
| T3 | S4 | inline | — | pending | — |
| T4 | S1, S2, S3 | inline | — | pending | — |

Route evidence: T1-T4 touch shared server files and their own islands, and T2 depends on T1; no parallel writers. T1 gets its own commit because it names a high-risk item.

## Log

- **L1 (2026-11-19, user, verbatim):** "en la misma pagina, tengo la duda, que es lo que hace el boton Mark as printed, se supone que al marcar eso, deberia no permitirme \"Send to print\", en la vista /dashboard#links, ahi deberia indica algo como impresas"
- **L2 (2026-11-19, user, verbatim):** "si, vamos con la B, la idea antes del tema del patch, era que eso consumia mucho recurso en la pagina, ahora se esa migrando a react y con react, deberia funcionar mejor el manejo de estados"
- **L3 (evidence, current code):** `Mark as printed` calls `window.__clearPrintQueue()` and nothing else (`web/src/cards/CardsSection.tsx`), the queue is an in-memory array (`web/src/print-queue.ts`) and a reload starts empty. The server side of the old design still exists and is unused by the UI: `print_queued_at`, `GET /api/links/print-queue`, `POST /api/links/printed`.
- **L4 (decision, mine):** keep `print_queued_at` and its endpoints untouched; `POST /api/links/printed` is reused for the new meaning — record `printed_at`, clear `print_queued_at`, answer `{ printed }`. Its old response was `{ cleared }`; no in-repo consumer called it (the dashboard does not), so the response key moves with the meaning and the README follows.
- **L5 (decision, mine):** `printed_at` is not cleared by saving a destination. The card exists physically and its QR encodes the short URL, so re-pointing the link does not unprint it.
