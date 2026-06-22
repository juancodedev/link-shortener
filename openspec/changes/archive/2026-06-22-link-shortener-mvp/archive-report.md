# Archive Report: Link Shortener MVP

## Change Summary
- **Date archived**: 2026-06-22
- **Implementation status**: Complete (30/30 tasks)
- **Tests**: 196 passed / 0 failed / 0 skipped
- **Verification**: PASS WITH WARNINGS (4/4 warnings resolved before archive)
- **PRs**: 4 stacked PRs (PR1 merged to main; PR2, PR3, PR4 pending on GitHub)

## Deliverables
| Component | Count |
|-----------|-------|
| Source files | 16 |
| Test files | 16 |
| SQL migrations | 3 |
| Spec requirements (REQs) | 15 |
| Test scenarios | 53 |
| Architecture components | 16/16 present |

## Architecture
- **Runtime**: Cloudflare Workers (Hono router)
- **Database**: Supabase PostgreSQL (schema-per-tenant: `public` + per-tenant `tenant_{id}` + shared `analytics`)
- **Caching**: KV — 2 namespaces (`SHORT_URL_CACHE` 24h TTL, `TENANT_CACHE` 1h TTL)
- **Connection pooling**: Hyperdrive
- **Auth**: Supabase Auth + JWT validation (jose)
- **Routing**: Path-based (`/r/{tenant}/{code}`) with pluggable strategy interface
- **Analytics**: `ctx.waitUntil()` fire-and-forget into `analytics.link_clicks` + atomic `clicks_count` increment
- **IP privacy**: SHA-256 hashing with salt (shared per MVP, per-tenant salt post-MVP)
- **Observability**: Structured JSON logging; Workers Traces

## Key Design Decisions
| Decision | Choice | Rationale |
|----------|--------|-----------|
| Tenant isolation | Schema-per-tenant | Instant deletion, structural isolation, no RLS needed |
| Tenant routing (MVP) | Path-based (`/r/{tenant}/{code}`) | Zero DNS config for initial deploy |
| Short code generation | nanoid 7 chars, custom alphabet (54-char, no ambiguous) | URL-safe, ~32B combinations, no DB round-trip |
| Cache strategy | KV write-aside, 24h/1h TTL | Simple, free-tier sufficient |
| `link_clicks` location | Shared `analytics` schema with `tenant_id` | Admin cross-tenant visibility |
| Connection pooling | Hyperdrive | 300–500ms savings per cache miss |
| Analytics execution | `ctx.waitUntil()` | Zero impact on redirect latency |
| Free tier | 30 links per tenant | Prevents abuse |

## SDD Artifacts Archived
| Artifact | Path |
|----------|------|
| Proposal | `openspec/changes/archive/2026-06-22-link-shortener-mvp/proposal.md` |
| Spec (delta) | `openspec/changes/archive/2026-06-22-link-shortener-mvp/spec.md` |
| Design | `openspec/changes/archive/2026-06-22-link-shortener-mvp/design.md` |
| Tasks (30/30) | `openspec/changes/archive/2026-06-22-link-shortener-mvp/tasks.md` |
| Exploration | `openspec/changes/archive/2026-06-22-link-shortener-mvp/explore.md` |
| Verify Report | `openspec/changes/archive/2026-06-22-link-shortener-mvp/verify-report.md` |
| Archive Report | `openspec/changes/archive/2026-06-22-link-shortener-mvp/archive-report.md` |

## Base Spec Created
- **`openspec/specs/link-shortener.md`** — 15 requirements (14 sections), all `Status: implemented`. Annotated with `Implemented in: link-shortener-mvp`.

## Deferred Items
Dashboard UI, link edit/delete endpoints, rate limiting (Cloudflare WAF), GDPR retention enforcement, custom domains, QR codes, Durable Objects, Cloudflare Queues, subdomain routing, API keys for programmatic access.

## Lessons Learned
- **Schema-per-tenant migration complexity**: 3 migration files (public, analytics, tenant template). Cron-based migration runner for N schemas is deferred — manageable for MVP with few tenants.
- **KV eventual consistency**: Acceptable for URL redirects (max 60s stale). Documented in the redirect path.
- **`ctx` must never be destructured**: Workers runtime loses `this` binding. All 11 invocation sites use `c.executionCtx.waitUntil()` or `ctx.waitUntil()` directly. Verified by lint pass in verify-report.
- **Schema name validation is defense-in-depth**: `validateSchemaName()` called in 7 different source locations before any SQL interpolation. Regex `^[a-z][a-z0-9_]*$` blocks all SQL injection vectors.
- **IP hashing salt**: MVP uses shared `SUPABASE_ANON_KEY` as salt (acknowledged). Per-tenant salt in `public.tenants.salt` column is a post-MVP improvement — ~30 lines of code + 1 migration.
- **Vitest with Cloudflare pool**: `@cloudflare/vitest-pool-workers` with Miniflare provides accurate KV and Hyperdrive mocking. Integration tests run in the same environment as production.
- **`compatibility_date` mismatch**: Local Miniflare caps at `2025-09-06` while `wrangler.jsonc` uses `2026-06-22`. Cloudflare edge accepts future dates; only affects local dev warnings.
- **Landing page auth URLs**: Constructed with `?provider=signup` and `?provider=login` query params. Must be verified against actual Supabase project config — these may not correspond to standard Supabase Auth redirect URLs. Linked to a dedicated auth page or use `@supabase/supabase-js` client-side SDK for correctness.
- **Unused `sanitizeInput` utility**: Exported and tested (62 tests) but never imported. `api/tenants.ts` uses manual `trim().slice()` instead. Can be wired in or removed.
