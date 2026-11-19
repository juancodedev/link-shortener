# Dashboard migration to React

Objective: move the dashboard UI from template strings in `src/handlers/dashboard.ts` to a React + Vite app served by the same Worker, one section at a time, keeping every current behavior.
Branch: `feat/dashboard-react` · Delivery: `ask-on-risk` (one PR per slice, assumed stacked-to-main until the user says otherwise) · Runner: `pnpm test` (vitest, Workers pool + jsdom project for `web/`), `pnpm run typecheck`.

## Specs

- **S1 — Scope.** "quizas ya sea hora de migrar esto a react" / "si, dale con todo". Only the dashboard migrates. The public pages (redirect, gate, action-screen, landing, setup) stay server-rendered (assistant proposal accepted with "si, dale con todo").
- **S2 — Incremental islands.** Sections move one by one, starting with Cards. Until the shell migrates, the legacy page loads the React bundle, which mounts in place of a migrated section and reuses `window.__api` (Bearer token + `X-Tenant-Slug`). A section's legacy markup and script are removed in the same change that mounts its React version. (Assumption: architecture proposed by the assistant.)
- **S3 — Toolchain.** React app in `web/`, built by Vite to `dist-web/` and served through Workers Static Assets (`assets` in `wrangler.jsonc`). CI and deploy build it before tests and deploy; `pnpm --frozen-lockfile` only (existing `test/toolchain.test.ts` rule). React tests run in jsdom; Worker tests keep the Workers pool. `typecheck` covers `web/`.
- **S4 — Cards parity.** The Cards section keeps every behavior of `odd/tasks/print-queue-cards.md` S2-S6 and the sheet-size fix of PR #112: variants, designs, mirror, crop, presets incl. "Oficio (216×330 mm)", editable width/height synced with the preset, margin/gap, zoom only on sheets, top-left grid, print only sheets with `@page` at sheet size, "Mark as printed" with confirm, per-card remove, sidebar count badge, queue in page memory (empty on reload).
- **S5 — Remaining sections.** Links, Overview, Businesses, Comments, Settings follow, each as its own slice.
- **S6 — Shell.** Last: auth bootstrap, tenant picker, sidebar/topbar move to React; `/dashboard` serves the SPA; `src/handlers/dashboard.ts` is deleted.

## Tasks

| ID | Specs | Route | Status | Commit |
|----|-------|-------|--------|--------|
| T1 | S3 | inline | in progress — Vite/React toolchain, static assets, CI/deploy build, jsdom tests (Risk item 5) | |
| T2 | S2, S4 | inline | pending — Cards island + legacy print-queue bridge | |
| T3 | S5 | inline | pending — Links | |
| T4 | S5 | inline | pending — Overview | |
| T5 | S5 | inline | pending — Businesses, Comments, Settings | |
| T6 | S6 | inline | pending — Shell, auth, delete legacy handler | |

Route evidence: every task touches the shared shell or depends on T1, so no parallel writers; work inline.

## Log

- **L1 (2026-11-19, user, verbatim):** "quizas ya sea hora de migrar esto a react, que dices ?"
- **L2 (2026-11-19, user, verbatim):** "si, dale con todo" — in reply to the proposal: React only for the dashboard, section by section starting with Cards, public pages stay server-rendered.
- **L3 (2026-11-19):** Mapping found: `/dashboard` has no server auth/CSP; auth lives in the browser (`window.__api`); no `assets` binding and no build step in CI/deploy; dashboard tests compile client functions out of the HTML string, so migrated sections move to real component tests. The print queue never calls `/api/links/print-queue` or `/api/links/printed` (kept as is per print-queue-cards L3).
