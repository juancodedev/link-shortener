# Proposal: Link Shortener MVP

## 1. Summary

Multi-tenant URL shortener with click analytics, deployed on Cloudflare Workers + Supabase, using schema-per-tenant isolation. Links are served via path-based routing at `acortador.juancode.dev/r/{tenant}/{code}`. A simple landing page lives at the root domain. Portfolio project under MIT license.

## 2. Intent

### Problem

No self-serve, multi-tenant link shortener with true data isolation exists for teams and small businesses wanting branded short links with analytics.

### Target Users

Businesses, marketers, indie makers who need short links with click tracking and per-tenant data isolation.

### Success Criteria (MVP)

- User signs up, creates a tenant with a chosen subdomain, gets an isolated PostgreSQL schema
- User creates short links via API (`POST /api/links`) with JWT auth
- Redirect works: `acortador.juancode.dev/r/{tenant}/{code}` → original URL
- Click data recorded (country, device, referrer) with SHA-256 hashed IP
- Admin can view cross-tenant analytics via shared `analytics.link_clicks`
- Tenant deletion is clean: `DROP SCHEMA CASCADE` + `DELETE FROM analytics.link_clicks`
- Free tier: 30 links per tenant, enforced at API level
- Landing page at root domain — basic, functional, with sign-up/login links

## 3. Scope

### In Scope (MVP — P0)

- Tenant provisioning (sign-up → `CREATE SCHEMA` + DDL + KV warm)
- Path-based routing: `acortador.juancode.dev/r/{tenant}/{code}`
- Tenant resolution via KV cache: path prefix → schema name (1h TTL)
- Pluggable tenant resolution strategy (swap in subdomain routing later)
- Redirect endpoint with KV cache (24h TTL) + Hyperdrive fallback
- Link creation API (`POST /api/links`) with JWT auth
- 30-link limit enforcement per tenant
- Click tracking in shared `analytics.link_clicks` with `tenant_id`
- IP hashing (SHA-256 + per-tenant salt)
- Open redirect validation (protocol check, localhost/private IP block)
- `is_active` toggle and `expires_at` support on links
- Hyperdrive for Supabase connection pooling
- Structured JSON logging + Workers Traces enabled
- Tenant deletion: `DROP SCHEMA CASCADE` + analytics cleanup
- Landing page (basic HTML at root)
- Subdomain chosen by tenant at sign-up (availability check + reserved-word validation)

### Out of Scope (Deferred)

- Dashboard UI (link listing, analytics visualization)
- Link edit/delete endpoints (`PATCH`/`DELETE /api/links/:id`)
- Click analytics dashboard
- Rate limiting (Cloudflare WAF — configure later)
- GDPR: data export, retention policy enforcement (IP hashing is in MVP)
- Custom short codes, QR codes, custom domains
- Durable Objects, Queues for click buffering
- API keys for programmatic access
- Subdomain routing (future: `{tenant}.short.link/{code}`)

## 4. Approach

- **Database**: Supabase PostgreSQL. Three schema layers: `public` (tenants, profiles), per-tenant schemas (links), and shared `analytics` (link_clicks).
- **Compute**: Single Cloudflare Worker with Hono router.
- **Caching**: Two KV namespaces — `short_code→URL` (24h TTL) and `tenant→schema` (1h TTL). Write-aside strategy.
- **Auth**: Supabase Auth → JWT validation in Worker middleware.
- **Tenant resolution**: Pluggable strategy pattern. MVP: path-based — extract tenant slug from `/r/{tenant}/{code}`, KV lookup → schema name. Future: swap for subdomain extraction without changing redirect/API logic.
- **Analytics**: `ctx.waitUntil()` → Hyperdrive INSERT into `analytics.link_clicks`. Non-blocking, fire-and-forget.
- **Observability**: Structured JSON logging. Workers Traces with 5% sampling.
- **Landing page**: Static HTML served by Worker at root path.
- **Rollback**: Schema-per-tenant means per-tenant rollback is `DROP SCHEMA CASCADE`. KV cache invalidation via `KV.delete()`. Worker deploy rollback via `wrangler rollback`.

## 5. Technical Decisions

| Decision | Choice | Rationale | Trade-off |
|----------|--------|-----------|-----------|
| Tenant isolation | Schema-per-tenant | Instant deletion, structural isolation | Migration complexity × N schemas |
| Tenant routing (MVP) | Path-based (`/r/{tenant}/{code}`) | Zero DNS/config for initial deploy | Cleaner URLs with subdomain (future) |
| Short code generation | nanoid 7 chars, custom alphabet | URL-safe, ~32B combinations, no DB round-trip | Not human-readable |
| Cache strategy | KV write-aside, 24h/1h TTL | Simple, free tier sufficient | Eventually consistent (up to 60s stale) |
| `link_clicks` location | Shared `analytics` schema | Admin cross-tenant visibility | Two-step deletion (DROP SCHEMA + DELETE) |
| Connection pooling | Hyperdrive | 300–500ms savings per cache miss | Additional Cloudflare cost |
| Analytics path | `ctx.waitUntil()` (async) | Zero impact on redirect latency | Fire-and-forget (no retry in MVP) |
| IP storage | SHA-256 hash + per-tenant salt | GDPR-compliant from day one | Cannot reconstruct original IP |
| Subdomain assignment | User-chosen at sign-up | Better UX, brand identity | Availability checks, reserved words |
| Free tier | 30 links per tenant | Prevents abuse, leaves room for monetization | May limit early adopters |

## 6. Risks and Mitigations

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| SQL injection via schema name | High | Medium | Validate against KV cache + regex allowlist (`^[a-z][a-z0-9_]*$`) |
| `clicks_count` drift | Medium | Medium | Atomic `UPDATE`; Cron reconciliation job post-MVP |
| Migration complexity (N schemas) | Medium | Low (MVP) | Template provisioning; Cron migration runner later |
| KV eventual consistency | Low | Medium | Document behavior; acceptable for URL redirects |
| Supabase free tier exhaustion | Medium | Low | Monitor usage; upgrade path documented |

**Rollback strategy**: Schema-per-tenant enables per-tenant rollback via `DROP SCHEMA CASCADE`. Worker deployment rollback via `wrangler rollback`. KV cache invalidation via `KV.delete()` on affected keys.

## 7. Dependencies

- Supabase project + API keys (anon, service_role)
- Cloudflare account with Workers, KV, and Hyperdrive access
- `wrangler` CLI configured and authenticated
- Git repository initialized
- Domain `juancode.dev` with DNS record for `acortador.juancode.dev`
- Node.js + npm for Worker development

## 8. Open Questions (Future Phases — Not Blocking MVP)

- Landing page design specifics (defer to implementation)
- Monetization model and paid tier limits
- Whether to add subdomain routing when moving to dedicated domain
- Custom domain support architecture
- Analytics retention policy details
