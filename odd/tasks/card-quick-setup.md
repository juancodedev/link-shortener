# Card quick setup

## Objective

When a logged-in owner opens an unconfigured short link (e.g. `/ywaoSiE`), send them to a minimal setup page where they can set the destination URL and client ref in one step. Anonymous visitors keep seeing the current "card not configured" page.

## Problem / why

Configuring a freshly printed card today means opening the dashboard and finding the link in the list. The owner usually has the card in hand and has just scanned it; setup should happen right there.

## Constraints

- Server auth only reads `Authorization: Bearer` Supabase JWTs; there are no cookies. `GET /:code` cannot know the visitor is logged in, so the detection runs in the browser on the unconfigured page.
- Short links and the dashboard are served from the same origin (confirmed by user), so the Supabase session in `localStorage` is readable from the unconfigured page.
- Role enforcement is out of scope (single user for now); tenant membership is required.
- Reuse `PATCH /api/links/:id` for saving (it validates the URL and invalidates the KV cache).
- No redirect loops: a stale/expired session must never bounce between `/:code` and `/setup/:code`.

## Scope

- `GET /api/links/by-code/:code`: auth + tenant membership; returns the link id, code, destination, client ref, and the tenant slug the page needs for the PATCH.
- `GET /setup/:code`: HTML page (mobile-first) with destination URL + client ref + Save. On save, redirect to `/:code`.
- Unconfigured card page: small inline script that redirects to `/setup/:code` when a Supabase session exists.

## Acceptance criteria

- Logged-in member scanning an unconfigured card lands on `/setup/:code` with the client ref prefilled.
- Saving a valid URL updates the link and redirects to `/:code`, which now redirects to the destination.
- Anonymous visitor sees the unchanged unconfigured page.
- Invalid/expired session on `/setup/:code` goes to login (with return path), never back to `/:code`.
- Non-member gets 404 from the by-code endpoint (no existence leak across tenants).

## Delivery

- Strategy: `ask-on-risk`. Forecast: ~300 authored changed lines.

## Tasks

- [x] T1 — by-code lookup endpoint + tests. Route: delegated (writer trigger: 2+ non-trivial files). Commit `b8fe1ba`.
- [x] T2 — `/setup/:code` page + route (before catch-all) + tests. Route: delegated. Commit `a22acbb`.
- [x] T3 — session-detect script on unconfigured page + tests. Route: delegated. Commit `b677cf8`.
- [x] T4 — setup save survives an expired access token (fresh session at save, one refresh + one retry, draft in sessionStorage across login). Route: delegated. Commit `4ad3457`. (Review warning, fix approved by human.)
- [x] T5 — post-save cache propagation: PATCH returns the stored `original_url`; setup page confirms "Guardado" and navigates straight to it (fallback `/:code`). Route: delegated. Commit: this T5 commit (see `git log`, `fix(setup): go straight to the saved destination after setup`). (Review warning, fix approved by human; server-file option approved.)

## Checks

- `pnpm vitest run`
- `pnpm tsc --noEmit`

## Progress

- Branch `feat/card-quick-setup` created from `main`.
- T1 (`b8fe1ba`): `GET /api/links/by-code/:code`, auth only; registry → point membership check `(profile_id, tenant_id)` → link by short_code in the tenant schema. Unknown / non-member / missing link → identical 404. README route row added (required by `test/readme-routes.test.ts`; `README.md` added to the writer surface with human approval). Membership is a small point query in the handler, not the middleware's list query (`src/middleware/tenant.ts` stays untouched by decision).
  - RED: `getLinkByCode handler > returns the link and its tenant slug...` → `TypeError: getLinkByCode is not a function`; `router by-code lookup route > registers ...` → `expected -1 to be greater than or equal to 0`.
  - GREEN: `pnpm vitest run` 1012/1012; `pnpm tsc --noEmit` clean.
- T2 (`a22acbb`): `src/handlers/setup.ts` + `/setup/:code` route + README row. Login page (`src/handlers/auth.ts`) had no return path; it now honours `?next=` only when it matches `SAFE_NEXT_PATH` (`^/setup/[A-Za-z0-9_-]+$`), so no open redirect and never `/:code`. `MAX_CLIENT_REF_LENGTH` exported so the form's maxlength tracks the server limit.
  - RED: `test/handlers/setup.test.ts` → `Cannot find module '../../src/handlers/setup'`; `flat short link routing > serves the card setup page...` → `expected 404 to be 200`; catch-all ordering test → `expected -1 to be greater than or equal to 0`.
  - GREEN: `pnpm vitest run` 1033/1033; `pnpm tsc --noEmit` clean. Client-side flow (session, fetch, PATCH) is asserted structurally only; no browser runner.
- T3 (`b677cf8`): inline script on `renderCardNotConfigured`; code embedded via shared `scriptValue` (JSON + `<`/U+2028/U+2029 escaping). No CSP is set on these pages. Tests execute the inline script against a fake `localStorage`/`location`.
  - RED: `unconfigured card hands a logged-in owner to setup > sends a browser holding a Supabase session to /setup/:code` → `expected "vi.fn()" to be called with arguments: [ '/setup/ywaoSiE' ]` (+ encoding and script-escape tests).
  - GREEN: `pnpm vitest run` 1039/1039; `pnpm tsc --noEmit` clean.
- T4 (`4ad3457`): `src/handlers/setup.ts`, `test/handlers/setup.test.ts`. Tests execute the page's inline script with `new Function` against fake `window.supabase`, `document`, `fetch`, `location`, `sessionStorage`.
  - RED: `saving with an access token that expired... > reads the session again at save time...` → `expected 'Bearer load-token' to be 'Bearer fresh-token'`; `refreshes once and retries once...` → `expected "vi.fn()" to be called 1 times, but got 0 times`; `keeps the input as a draft...` → `expected [ Array(1) ] to have a length of 2 but got 1`; `restores the draft...` → `expected 'https://old.example' to be 'https://example.com/menu'`.
  - GREEN: `pnpm vitest run` 1047/1047; `pnpm tsc --noEmit` clean.
- T5 verification (no code change made):
  - First-time configuration (the main flow) CANNOT be served stale. The unconfigured branch returns before any KV write (`src/handlers/redirect.ts:217`, cache write is at `:263`), and a cache miss or null destination always goes to Postgres (`src/handlers/redirect.ts:162`). The registry entry `reg:{code}` (`src/cache/shortcode.ts:102-109`) holds tenant/link id/billing, not the destination, and a destination edit doesn't change it.
  - Editing an EXISTING destination CAN briefly serve the old one. `/:code` reads `{slug}:{code}` from `SHORT_URL_CACHE` (`src/handlers/redirect.ts:133`, key at `src/cache/shortcode.ts:28-30`, TTL 24h at `:4`). The PATCH deletes that key only inside `waitUntil`, after returning `{ ok: true }` (`src/api/links.ts:1102-1111`), so the browser's immediate `location.replace("/" + code)` can race the delete. KV deletes are also eventually consistent across locations.
  - Fix needed a server change: the PATCH response returns only `{ ok: true }` (`src/api/links.ts:1111`), so it does not carry the normalized `original_url` to navigate to. Needs `src/api/links.ts` (return the normalized `original_url` on PATCH) + `test/api/links.test.ts`, then `src/handlers/setup.ts` + `test/handlers/setup.test.ts` to navigate there. Those files were outside the first T4/T5 writer surface, so the writer stopped; the human then approved them.
- T5 implementation: `src/api/links.ts` (`RETURNING ... original_url`; response `{ ok: true, original_url }` only when the PATCH set or cleared the destination, otherwise exactly `{ ok: true }`), `test/api/links.test.ts`, `src/handlers/setup.ts` (shows "Guardado", then after 700 ms goes to the returned destination if it is http(s), otherwise `/:code`), `test/handlers/setup.test.ts`. Dashboard PATCH callers only read `res.ok` (`src/handlers/dashboard.ts:1646,1662,1702`), so they are unaffected. Two existing `original_url on updateLink` tests were updated to the additive response shape.
  - RED: `updateLink returns the saved destination > returns the stored original_url...` → `expected 'UPDATE "tenant_a7f3"."links" SET orig…' to match /RETURNING[^;]*\boriginal_url\b/`; `returns null when the destination is cleared` → `expected "vi.fn()" to be called with arguments: [ { ok: true, original_url: null } ]`; `after a successful save > confirms and goes straight to the destination...` → `expected 'Guardando…' to be 'Guardado'`.
  - Caught during GREEN: inside the TS template literal, `\/` renders as `/`, which turned the http(s) regex into a `//` comment; the "never navigates to a non-http destination" test caught it. It is now double-escaped and pinned by a rendered-HTML assertion.
  - GREEN: `pnpm vitest run` 1053/1053; `pnpm tsc --noEmit` clean.
- Known noise: a workerd `uncaught exception ... internal error` log line appears in `pnpm vitest run` on the base too; not caused by this feature.
- Delivery: authored lines ≈ 817 (808+/9−) vs forecast ~300; over the ~400 budget under `ask-on-risk`.

## Next step

All tasks done (T1–T5). Parent: delivery decision for the over-budget branch, then a check on a real phone (scan an unconfigured card logged in and logged out; edit an existing destination and confirm the new one opens).
