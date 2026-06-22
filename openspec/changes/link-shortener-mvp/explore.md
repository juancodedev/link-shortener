# Exploration: Link Shortener MVP

## Current State

The project is empty — no code, no git history, no infrastructure. The user proposes a URL shortener (similar to bit.ly) deployed on Cloudflare Workers with Supabase (PostgreSQL) as the database. The `sdd-init` phase completed, establishing the OpenSpec structure at `openspec/`. No testing framework is configured.

## Proposed Architecture Summary

- **Database**: Supabase PostgreSQL with three tables: `profiles`, `links`, `link_clicks`
- **Compute**: Single Cloudflare Worker with three modules:
  - `handlers/redirect.ts` — Fast path: lookup by `short_code`, Response.redirect
  - `handlers/analytics.ts` — Async path: non-blocking analytics insert via `ctx.waitUntil()`
  - `api/links.ts` — Management CRUD protected by Supabase JWT
- **Auth**: Supabase Auth with RLS policies for multi-tenant isolation
- **Cache**: KV for `short_code` → `original_url` mapping (implied, not explicit in proposal)

---

## Affected Areas

- `openspec/changes/link-shortener-mvp/` — All SDD artifacts for this change
- `supabase/migrations/` — Schema, RLS policies, indexes (to be created)
- `src/handlers/redirect.ts` — Redirect fast path (to be created)
- `src/handlers/analytics.ts` — Click analytics capture (to be created)
- `src/api/links.ts` — CRUD API for link management (to be created)
- `src/cache/` — KV cache layer for `short_code` lookups (to be created)
- `src/auth/` — JWT validation and Supabase auth integration (to be created)
- `wrangler.jsonc` — Worker configuration, bindings, secrets (to be created)

---

## 1. Schema Design Analysis

### 1.1 `clicks_count` Redundancy vs. Derived Count

**Current proposal**: `links.clicks_count INTEGER DEFAULT 0` — a denormalized counter.

**Trade-off analysis**:

| Approach | Pros | Cons |
|----------|------|------|
| **Denormalized counter** (proposed) | O(1) read for dashboard queries; no JOIN or COUNT needed | Risk of drift from actual `link_clicks` rows; every click is two writes (INSERT + UPDATE); UPDATE contention under high throughput |
| **Derived COUNT from link_clicks** | Single source of truth; no sync risk; no UPDATE contention | Every dashboard query requires COUNT aggregation; performance degrades with scale; needs materialized view or caching layer |
| **Hybrid: eventual consistency** | Fast reads, eventual accuracy | Complex reconciliation logic; stale counts visible to users |

**Recommendation**: Use the denormalized counter for the MVP but implement a reconciliation mechanism:
- Use a **Queue** (Cloudflare Queues) to buffer click events instead of direct DB writes
- Increment `clicks_count` atomically via `UPDATE links SET clicks_count = clicks_count + 1`
- Run a periodic reconciliation job (Cron Trigger) to cross-check `clicks_count` against `COUNT(*)` from `link_clicks`
- For high-scale scenarios, consider **Durable Objects** as an in-memory counter that flushes to DB periodically (avoids UPDATE contention)

**Severity**: HIGH — drift in `clicks_count` undermines trust in analytics.

### 1.2 GDPR and Data Privacy Implications

**Critical finding**: The proposed schema stores `ip_address` in plaintext — this is **personal data under GDPR** and requires explicit legal basis.

| Field | GDPR Concern | Recommendation |
|-------|-------------|----------------|
| `ip_address` | Directly identifying personal data | Hash with SHA-256 + salt before storage; OR store only truncated IP (last octet zeroed); OR use Cloudflare's `cf.country` only and discard IP entirely |
| `user_agent` | Potentially identifying when combined with IP | Store only parsed device/browser type, not raw UA string |
| `referer` | May contain personal data in query strings | Strip query parameters before storage |

**Required additions**:
- Data retention policy: define maximum storage period (recommend 90 days for raw click data, indefinite for aggregated counts)
- Deletion mechanism: implement cascade delete from `links` → `link_clicks` on user account deletion
- Privacy policy link in the UI
- `created_at` should have an automatic retention cleanup via a scheduled job

**Severity**: CRITICAL — GDPR non-compliance exposes to fines up to 4% of global revenue.

### 1.3 Column Naming: `referer` vs `referrer`

The HTTP header is `Referer` (a famous misspelling from HTTP/1.0). The database column should use the correct spelling `referrer`. Using `referer` in the database schema propagates the misspelling unnecessarily.

**Recommendation**: Use `referrer` as the column name. Document in code comments that it maps to the `Referer` HTTP header.

**Severity**: LOW — cosmetic, but worth fixing at schema stage.

### 1.4 Missing Fields

| Missing Field | Purpose | Severity |
|---------------|---------|----------|
| `is_active` (BOOLEAN) | Enable/disable links without deleting | HIGH — no way to temporarily disable a malicious link |
| `deleted_at` (TIMESTAMPTZ) | Soft delete support | MEDIUM — GDPR right to deletion requires hard delete anyway; but useful for accidental deletion recovery |
| `expires_at` (TIMESTAMPTZ) | Time-limited links | MEDIUM — common feature request for promotional/temporary links |
| `password_hash` (TEXT) | Password-protected links | MEDIUM — premium feature; adds complexity to redirect flow |
| `utm_source`, `utm_medium`, `utm_campaign` | UTM parameter preservation | LOW — can be parsed from `original_url` on creation |
| `updated_at` (TIMESTAMPTZ) | Track link edits | LOW — useful for audit trail |
| `custom_domain` (TEXT) | Multi-tenant custom domains | LOW — adds significant complexity; defer to post-MVP |

**Recommendation**: Add `is_active` (required for MVP), `expires_at` (nice to have), and `updated_at` (best practice). Defer `password_hash`, soft delete, UTM fields, and custom domains.

### 1.5 `short_code` Generation Strategy

**Not specified in proposal.** This is a critical design decision that affects uniqueness guarantees, collision probability, and URL readability.

| Strategy | Pros | Cons |
|----------|------|------|
| **nanoid** (custom alphabet, 7-8 chars) | URL-safe, collision-resistant, configurable length, fast | Unpredictable order; not human-readable |
| **SHA-256 hash truncation** | Deterministic from URL; no collision in practice for known URLs | Long if not truncated; known hash can reveal target URL |
| **AUTO_INCREMENT + base62 encoding** | Sequential, short, predictable | Reveals link count; requires DB round-trip for generation |
| **UUIDv4 + base62** | No collision, no DB round-trip | Long (21+ chars); not human-friendly |

**Recommendation**: Use **nanoid** with a custom alphabet (no ambiguous chars: remove `0OI1l`) at 7 characters, giving ~32 billion possible combinations. Use the UNIQUE constraint on `short_code` with retry-on-collision (extremely rare at this length, but handle gracefully). Generate the code in the Worker (no DB round-trip needed), and validate uniqueness at insert time.

**Per-tenant uniqueness**: With schema-per-tenant + subdomain routing, short codes only need to be unique within their schema. `acme.short.link/abc123` and `beta.short.link/abc123` can both use `abc123` — they resolve to different schemas. This eliminates the need for a global short_code registry and cross-tenant collision checks.

```typescript
import { customAlphabet } from "nanoid";
const alphabet = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const generateShortCode = customAlphabet(alphabet, 7);
```

**Severity**: CRITICAL — no short_code strategy means no links can be created.

### 1.6 Index Strategy

The proposed indexes cover basic redirect lookup and click audit joins, but miss query patterns for the user dashboard.

**Current indexes (proposed)**:
- `idx_links_short_code ON links(short_code)` — ✅ Correct for redirect lookups
- `idx_link_clicks_link_id ON link_clicks(link_id)` — ✅ Correct for per-link analytics

**Missing indexes**:
- `idx_links_user_id ON links(user_id)` — **CRITICAL**: User dashboard queries (list my links, order by created_at, clicks_count)
- `idx_links_user_id_created_at ON links(user_id, created_at DESC)` — User dashboard with pagination
- `idx_link_clicks_created_at ON link_clicks(created_at DESC)` — Retention cleanup jobs
- `idx_link_clicks_link_id_created_at ON link_clicks(link_id, created_at DESC)` — Per-link analytics with time ranges

**Recommendation**: Add all four missing indexes. The user dashboard query (list by `user_id` + order by `created_at`) will be the second most frequent query after redirect lookups.

**Severity**: CRITICAL — without `idx_links_user_id`, user dashboard queries will full-scan the `links` table.

---

## 2. Supabase-Specific Analysis

### 2.1 RLS Policy Design

The proposed schema uses `profiles.id REFERENCES auth.users ON DELETE CASCADE`. RLS policies must ensure users can only access their own data.

**Required RLS policies**:

```sql
-- profiles: users can read their own profile
CREATE POLICY "Users can read own profile"
  ON profiles FOR SELECT
  USING (auth.uid() = id);

-- links: users can CRUD their own links
CREATE POLICY "Users can manage own links"
  ON links FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- link_clicks: users can read clicks for their own links
CREATE POLICY "Users can read clicks for own links"
  ON link_clicks FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM links
      WHERE links.id = link_clicks.link_id
      AND links.user_id = auth.uid()
    )
  );
```

**RLS pitfalls to avoid**:
- `auth.uid()` returns NULL for unauthenticated requests, which makes RLS policies reject by default — correct behavior, but must be handled explicitly in the API
- The `profiles` table auto-creates via trigger on `auth.users` insert (recommended) — avoid the race condition where a user tries to create a link before their profile row exists
- RLS on `link_clicks` using `EXISTS` subquery can be slow at scale — consider adding `user_id` column to `link_clicks` as a denormalization for policy evaluation

**Recommendation**: Add `user_id` directly to `link_clicks` table to simplify RLS policies and improve performance. The added storage cost is negligible compared to the JOIN overhead on every read.

### 2.2 RLS Alone is Not Rate Limiting

RLS provides data isolation, not abuse protection. An attacker with a valid JWT can:
- Enumerate short_codes by brute force
- Flood the API with link creation requests
- DDoS the redirect endpoint

**Rate limiting strategies**:
1. **Cloudflare WAF Rate Limiting Rules** — Best option for edge-level rate limiting. Configure per-path rules (e.g., 100 req/min to `/api/*`, 1000 req/min to `/r/*`).
2. **Supabase rate limiting** — Not built-in. Supabase offers Auth rate limiting (login attempts) but not general API rate limiting.
3. **Worker-level token bucket** — Implement in the Worker itself using KV for state. Adds complexity but allows per-user limits.

**Recommendation**: Use Cloudflare WAF rate limiting rules for the MVP (simplest, most effective). Add Worker-level rate limiting post-MVP if finer-grained control is needed.

**Severity**: HIGH — no rate limiting means the service is trivially abusable.

### 2.3 Supabase Realtime for Live Click Updates

Supabase Realtime (WebSocket-based) could power live click count updates in the dashboard. Trade-offs:
- **Pros**: No polling needed; instant updates; built into Supabase
- **Cons**: WebSocket connections count against Supabase plan limits; adds client complexity; unnecessary for MVP

**Recommendation**: Defer to post-MVP. Use polling (every 10-30s) or manual refresh for the MVP dashboard.

### 2.4 Edge Functions vs Cloudflare Workers

Supabase Edge Functions (Deno) and Cloudflare Workers are both valid for serverless compute. For this project:
- **Cloudflare Workers** are already chosen — they excel at edge-routing (redirects) and global latency
- **Supabase Edge Functions** would be a natural choice if all compute stayed within Supabase ecosystem, but the redirect path benefits from Cloudflare's global network
- Mixing both adds unnecessary complexity — stick with Workers

**Recommendation**: Keep all compute on Cloudflare Workers. Use Supabase exclusively for Auth + Database.

### 2.5 Connection Pooling: Hyperdrive is Mandatory

**Critical finding per Workers best practices**: Direct `fetch` to Supabase from Workers without connection pooling incurs 300-500ms of TCP+TLS+auth overhead on every request. This is the single biggest latency risk for the redirect path.

**Cloudflare Hyperdrive** is the platform-native solution:
- Maintains regional connection pools to Supabase PostgreSQL
- Eliminates per-request TCP/TLS handshake
- Includes query result caching for repeated reads
- Requires `nodejs_compat` flag and `pg` npm package
- Create new `Client` per request — Hyperdrive manages the pool underneath

**Configuration**:
```jsonc
{
  "compatibility_flags": ["nodejs_compat"],
  "hyperdrive": [
    {
      "binding": "HYPERDRIVE",
      "id": "<HYPERDRIVE_ID>",
      "localConnectionString": "postgres://postgres:password@localhost:54322/postgres"
    }
  ]
}
```

**Worker code (redirect path)**:
```typescript
import { Client } from "pg";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const shortCode = extractShortCode(request);
    
    // Try KV cache first
    const cached = await env.SHORT_URL_CACHE.get(shortCode);
    if (cached) {
      // Fire-and-forget analytics
      ctx.waitUntil(trackClick(shortCode, request, env));
      return Response.redirect(cached, 301);
    }

    // Cache miss: query Supabase via Hyperdrive
    const client = new Client({ connectionString: env.HYPERDRIVE.connectionString });
    try {
      await client.connect();
      const result = await client.query(
        "SELECT original_url FROM links WHERE short_code = $1 AND is_active = true",
        [shortCode]
      );
      if (result.rows.length === 0) {
        return new Response("Not found", { status: 404 });
      }
      const originalUrl = result.rows[0].original_url;
      
      // Populate cache (non-blocking)
      ctx.waitUntil(env.SHORT_URL_CACHE.put(shortCode, originalUrl, { expirationTtl: 86400 }));
      ctx.waitUntil(trackClick(shortCode, request, env));
      
      return Response.redirect(originalUrl, 301);
    } catch (e) {
      console.error(JSON.stringify({ message: "DB query failed", error: String(e), code: shortCode }));
      return Response.json({ error: "Service unavailable" }, { status: 503 });
    }
  },
} satisfies ExportedHandler<Env>;
```

**Recommendation**: Hyperdrive is MANDATORY for this architecture. Without it, every redirect that misses KV cache pays 300-500ms penalty, making the service unusable at scale.

**Severity**: CRITICAL — without Hyperdrive, the redirect path is too slow.

---

## 3. Cloudflare Workers Analysis

### 3.1 CPU Time Limits vs Query Latency

Workers CPU time (10ms free / 30s paid default) measures only active CPU execution, NOT time spent waiting on network I/O (fetch, KV, Hyperdrive queries). This is crucial: a Supabase query that takes 50ms wall-clock might only use 0.5ms of CPU time.

**Redirect path CPU profile estimate**:
- Extract short_code from URL: ~0.1ms
- KV get(): ~0.2ms CPU + network wait
- Hyperdrive query (on cache miss): ~0.5ms CPU + 10-50ms network wait
- Response.redirect(): ~0.1ms CPU
- ctx.waitUntil() fire: ~0.1ms CPU
- **Total CPU: ~1ms** (well within 10ms free limit)
- **Total wall-clock: 15-60ms** (KV cache hit: ~5ms; cache miss: 20-80ms)

**Recommendation**: The redirect path easily fits within free-tier CPU limits. The network wait on Hyperdrive queries is the latency driver, not CPU execution. KV cache hit rate is the critical metric for user experience.

### 3.2 KV Cache Strategy

**KV characteristics**:
- Eventually consistent (writes propagate globally in <60s, usually <1s)
- Reads: sub-millisecond when warm
- 100,000 reads/day free, then $0.50/million
- Key size: up to 512 bytes; Value size: up to 25 MiB
- TTL support for automatic expiration

**Cache strategy options**:

| Strategy | Description | Pros | Cons |
|----------|-------------|------|------|
| **Write-aside (recommended)** | Read from KV first; on miss, read DB and populate KV | Simple; KV handles expiration via TTL | First request after expiration is slow (cache miss) |
| **Write-through** | Write to DB and KV on link creation/update | KV always in sync; no cache misses for existing links | Double-write latency on creation; eventual consistency of KV means stale reads possible |
| **Write-behind** | Write to KV first, async write to DB | Fastest writes | Risk of data loss if Worker crashes before DB write; complex failure handling |

**Recommendation**: **Write-aside with 24-hour TTL** for the MVP. On link creation, populate KV immediately (backfill). On link update/deletion, invalidate KV key. KV's eventual consistency means a reader might briefly see the old URL after an update — acceptable for a URL shortener where updates are rare.

**KV vs Upstash Redis**:
- KV: free tier sufficient for MVP (100k reads/day), global distribution, TTL, simple API
- Redis (Upstash): stronger consistency, more data structures, lower latency, but paid from day one
- **Verdict**: KV for MVP. Revisit if consistency needs become strict.

### 3.3 `ctx.waitUntil()` for Async Analytics

Per Workers best practices:
- **Do not destructure `ctx`** — loses `this` binding, causes "Illegal invocation"
- **Use `ctx.waitUntil()`** for post-response work (log analytics, update cache)
- `waitUntil()` has a 30-second time limit after response is sent
- Every promise passed to `waitUntil()` must handle its own errors

**Correct pattern**:
```typescript
async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const shortCode = extractShortCode(request);
  const originalUrl = await lookupOrCache(shortCode, env);

  // Fire analytics in background — non-blocking
  ctx.waitUntil(
    trackClick(shortCode, request, env).catch((e) =>
      console.error(JSON.stringify({ message: "analytics failed", error: String(e), code: shortCode }))
    )
  );

  return Response.redirect(originalUrl, 301);
}
```

**Anti-pattern to avoid**:
```typescript
// WRONG: await-ing analytics blocks the redirect response
const { waitUntil } = ctx; // WRONG: destructuring loses this binding
await trackClick(shortCode, request, env); // WRONG: user waits for analytics
return Response.redirect(originalUrl, 301);
```

**Recommendation**: Use `ctx.waitUntil()` with explicit error handling. Never await analytics. The redirect response must be sent to the client before analytics processing begins.

### 3.4 Durable Objects Alternative for Counter Aggregation

For high-scale scenarios (10M+ clicks/day), updating `clicks_count` on every click creates UPDATE contention on the `links` table.

**Durable Objects approach**:
- Each `short_code` maps to a Durable Object that holds an in-memory counter
- Clicks increment the counter in-memory (no DB round-trip)
- Durable Object flushes the accumulated count to Supabase every N seconds or every M clicks
- Reduces DB writes by 100-1000x

**Trade-offs**:
- Adds architectural complexity (DO routing, Global Unique IDs, alarm-based flush)
- DOs have per-request costs after free tier
- DOs are strongly consistent within themselves — solves the drift problem
- Overkill for MVP unless expecting >10k clicks/day

**Recommendation**: Defer Durable Objects. Use direct `ctx.waitUntil()` → Hyperdrive INSERT for the MVP. If `links` UPDATE contention becomes a problem, introduce a Cloudflare Queue buffer before jumping to Durable Objects.

### 3.5 Worker Bindings and Secrets

**Secrets** (set via `wrangler secret put`, never in config):
- `SUPABASE_URL` — Supabase project URL
- `SUPABASE_ANON_KEY` — Supabase anonymous key (for JWT validation)
- `SUPABASE_SERVICE_ROLE_KEY` — For server-side operations bypassing RLS (use sparingly)

**Non-secret config** (in `wrangler.jsonc`):
- `ENVIRONMENT`: "production" | "staging"
- `SHORT_URL_DOMAIN`: base domain for generated short URLs

**Bindings**:
```jsonc
{
  "kv_namespaces": [{ "binding": "SHORT_URL_CACHE", "id": "<KV_ID>" }],
  "hyperdrive": [{ "binding": "HYPERDRIVE", "id": "<HYPERDRIVE_ID>" }]
}
```

### 3.6 Cloudflare Analytics Engine vs Custom `link_clicks`

For high-volume click data (100M+ clicks/month), the custom `link_clicks` table in Supabase becomes expensive to query and store.

**Cloudflare Analytics Engine** alternative:
- Purpose-built for high-cardinality event data
- Query via SQL (Workers Analytics Engine SQL API)
- $0.25/million events written, $0.50/million events read
- No storage limits, automatic retention
- BUT: separate system from Supabase — users can't query their click data via the same API

**Recommendation**: Keep `link_clicks` in Supabase for the MVP. It provides unified data access and simpler dashboards. Revisit Analytics Engine if the `link_clicks` table grows beyond 10M rows or query performance degrades.

---

## 4. Architecture Patterns

### 4.1 CQRS-Lite: Separate Read and Write Paths

The proposed architecture already follows a CQRS-lite pattern:
- **Read (redirect)**: KV cache → Hyperdrive query → 301 redirect. Optimized for speed.
- **Write (analytics)**: `ctx.waitUntil()` → INSERT into `link_clicks` + UPDATE `clicks_count`. Async, non-blocking.
- **Write (management)**: CRUD API with JWT validation. Standard request-response.

**Recommendation**: Formalize this separation in the code structure, adding tenant-aware layers:
```
src/
├── handlers/
│   ├── redirect.ts    # Read-optimized: subdomain→schema→cache→DB→redirect
│   └── router.ts      # Route dispatcher: subdomain extraction, /r/:code, /api/*
├── api/
│   ├── links.ts       # CRUD endpoints (schema-qualified queries)
│   ├── tenants.ts     # Tenant management (provision, suspend, delete)
│   └── auth.ts        # JWT validation + tenant resolution middleware
├── analytics/
│   └── tracker.ts     # Click event recording (ctx.waitUntil, schema-qualified)
├── cache/
│   ├── shortcode.ts   # short_code → original_url (KV, per-tenant keys)
│   └── tenant.ts      # subdomain → schema_name (KV, global)
├── db/
│   ├── client.ts      # Hyperdrive client factory
│   └── schema.ts      # Schema name validation + qualified query builder
├── tenants/
│   ├── provision.ts   # CREATE SCHEMA + run DDL + warm KV
│   └── deprovision.ts # DROP SCHEMA CASCADE + cleanup registry + KV
└── utils/
    ├── short-code.ts   # nanoid generation
    └── validation.ts   # URL validation, input sanitization
```

### 4.2 Event-Driven: Queue Buffer for Click Events

For production scale, introducing a Queue between redirect and analytics provides:
- Back-pressure handling: if Supabase is slow, queue buffers events
- Batching: consumer processes events in batches, reducing DB round-trips
- Retry: failed inserts are automatically retried (Queues have built-in retry)
- Decoupling: analytics failures don't affect redirect path

**Flow**:
```
Client → Worker → Redirect Response
                 → ctx.waitUntil → Queue.send(event)
Queue Consumer → Batch INSERT into link_clicks → UPDATE clicks_count
```

**Recommendation**: Include Queues in the architecture design but implement them in a post-MVP iteration. The direct `ctx.waitUntil()` approach works for MVP volumes (<100k clicks/day).

### 4.3 API Design: REST vs RPC

**REST endpoints (recommended)**:
```
POST   /api/links              # Create short link
GET    /api/links              # List user's links (paginated)
GET    /api/links/:id          # Get link details
PATCH  /api/links/:id          # Update link (title, is_active, expires_at)
DELETE /api/links/:id          # Delete link (hard delete) + cascade clicks
GET    /api/links/:id/clicks   # Click analytics for a link (time range, aggregation)
```

**Auth**: Supabase JWT in `Authorization: Bearer <token>` header, validated in the Worker.

**Recommendation**: REST with JSON. Keep the API surface small for MVP. Add bulk operations and API keys for programmatic access post-MVP.

---

## 5. Security & Compliance Analysis

### 5.1 Open Redirect Protection

An open redirect occurs when the shortener redirects to an arbitrary URL without validation. Attackers use this to phish users (trusted shortener domain → malicious destination).

**Required validation**:
1. Validate URL format on creation (must be valid HTTP/HTTPS URL)
2. Block internal/local URLs (localhost, 127.0.0.1, 0.0.0.0, `file://`)
3. Consider domain allowlist/blocklist for production
4. Add interstitial/warning page for flagged URLs (post-MVP)

```typescript
function isValidRedirectUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    // Only allow http and https
    if (!["http:", "https:"].includes(parsed.protocol)) return false;
    // Block localhost and private IPs
    const blockedHosts = ["localhost", "127.0.0.1", "0.0.0.0", "[::1]"];
    if (blockedHosts.includes(parsed.hostname)) return false;
    return true;
  } catch {
    return false;
  }
}
```

**Severity**: CRITICAL — open redirect is an OWASP Top 10 vulnerability.

### 5.2 Input Validation

| Input | Constraints | Validation |
|-------|-------------|------------|
| `original_url` | Valid URL, max 2048 chars, http/https only | `new URL()` + protocol check + length limit |
| `short_code` (creation) | 4-20 chars, alphanumeric + `-_` | Regex: `/^[a-zA-Z0-9_-]{4,20}$/` |
| `short_code` (redirect) | 1-50 chars, URL-safe | Exist in DB, not path traversal |
| `title` | Max 200 chars | Trim, sanitize (no HTML tags) |

### 5.3 GDPR Compliance Checklist

| Requirement | Implementation |
|-------------|---------------|
| **IP anonymization** | Hash IP with SHA-256 before storage, or store only `/24` prefix (last octet zeroed) |
| **Data retention** | Define and enforce maximum storage period (90 days recommended for raw clicks) |
| **Right to deletion** | Cascade delete: `links` → `link_clicks` on account deletion; provide API endpoint |
| **Consent** | Privacy policy must disclose click tracking; add consent checkbox if collecting analytics beyond basic redirect counting |
| **Data export** | Provide user with download of their link data and click analytics |
| **Data Processing Agreement** | Supabase provides DPA; Cloudflare provides DPA |

**Recommendation**: Implement IP hashing from day one. Add data retention cleanup as a Cron Trigger. Document the privacy policy before launch.

### 5.4 Abuse Prevention

**Phishing/malware URL detection**:
- MVP: manual moderation (review reported links)
- Post-MVP: integrate Google Safe Browsing API or Cloudflare's URL scanning
- Rate limiting on link creation (10/hour for free tier) deters automated abuse

**Severity**: HIGH — without abuse prevention, the domain could be blacklisted by browsers and security tools.

---

## 6. Observability

### 6.1 Workers Observability Configuration

Per Workers best practices:
```jsonc
{
  "observability": {
    "enabled": true,
    "logs": { "head_sampling_rate": 1 },
    "traces": { "enabled": true, "head_sampling_rate": 0.05 }
  }
}
```

### 6.2 Structured Logging

All logging must use structured JSON:
```typescript
console.log(JSON.stringify({
  event: "redirect",
  code: shortCode,
  cacheHit: true,
  durationMs: elapsed,
}));

console.error(JSON.stringify({
  event: "error",
  type: "db_query_failed",
  code: shortCode,
  error: String(e),
}));
```

### 6.3 Key Metrics to Track

| Metric | Source | Purpose |
|--------|--------|---------|
| Redirect P50/P95/P99 latency | Workers Traces | User experience monitoring |
| KV cache hit rate | Custom metric in logs | Cache effectiveness |
| Hyperdrive query latency | Workers Traces | DB performance |
| Click throughput (events/min) | Custom counter | Scale monitoring |
| Error rate (4xx, 5xx) | Workers dashboard | Reliability |
| CPU time per request | Workers Traces | Free-tier budget monitoring |

### 6.4 Error Tracking

- Supabase query failures: log full error, return 503 to client
- KV failures: fall through to DB query (graceful degradation)
- Analytics failures: log and swallow (never block redirect)
- JWT validation failures: return 401 with descriptive error

---

## 7. Product/Scope Decisions

### 7.1 Tenant Model: Schema-per-Tenant (PostgreSQL Schemas)

**Assessment**: The user explicitly requested true tenant isolation via PostgreSQL schemas — each tenant gets their own schema (`tenant_abc123`) with independent tables. This is a stronger isolation model than RLS-based multi-tenancy.

**Decision**: Schema-per-tenant from day one. This was chosen over RLS-based multi-tenancy for three reasons:
1. **Instant, safe deletion**: `DROP SCHEMA tenant_x CASCADE` removes all tenant data in one atomic operation. No cascade delete across millions of rows, no orphaned data.
2. **Structural isolation, not policy-based**: No RLS policies needed. A bug in a WHERE clause cannot leak data between tenants because they live in different namespaces.
3. **GDPR compliance**: Right to deletion is a single SQL command. Full data export is `pg_dump --schema=tenant_x`.

#### Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│  PostgreSQL Database                                │
│                                                     │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐          │
│  │  public  │  │tenant_a  │  │tenant_b  │  (...)   │
│  │          │  │          │  │          │          │
│  │ tenants  │  │ links    │  │ links    │          │
│  │ profiles │  │ link_    │  │ link_    │          │
│  │          │  │  clicks  │  │  clicks  │          │
│  └──────────┘  └──────────┘  └──────────┘          │
│                                                     │
│  auth.users (Supabase — shared, global)             │
└─────────────────────────────────────────────────────┘
```

#### Shared Schema (`public`) — Tenant Registry

```sql
CREATE TABLE tenants (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  schema_name TEXT UNIQUE NOT NULL,     -- 'tenant_a7f3'
  display_name TEXT NOT NULL,           -- 'Acme Corp'
  subdomain TEXT UNIQUE,                -- 'acme' → acme.short.link
  owner_id UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  is_active BOOLEAN DEFAULT true
);

CREATE TABLE profiles (
  id UUID REFERENCES auth.users ON DELETE CASCADE PRIMARY KEY,
  tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
  role TEXT DEFAULT 'member',           -- 'owner', 'admin', 'member'
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

#### Per-Tenant Schema (e.g., `tenant_a7f3`)

```sql
CREATE TABLE links (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  original_url TEXT NOT NULL,
  short_code TEXT NOT NULL,             -- UNIQUE within this schema only
  title TEXT,
  clicks_count INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE link_clicks (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  link_id UUID REFERENCES links(id) ON DELETE CASCADE,
  ip_hash TEXT,                         -- SHA-256(ip + per-tenant salt)
  user_agent_summary TEXT,              -- Parsed device/browser, not raw UA
  referrer TEXT,                        -- Stripped of query params
  country_code TEXT,
  device_type TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes (no user_id needed — schema is the isolation boundary)
CREATE UNIQUE INDEX idx_links_short_code ON links(short_code);
CREATE INDEX idx_links_created_at ON links(created_at DESC);
CREATE INDEX idx_link_clicks_link_id ON link_clicks(link_id);
CREATE INDEX idx_link_clicks_link_id_created_at ON link_clicks(link_id, created_at DESC);
CREATE INDEX idx_link_clicks_created_at ON link_clicks(created_at DESC);
```

**Key differences from single-schema approach**:
- No `user_id` in `links` or `link_clicks` — the schema itself is the tenant boundary
- No RLS policies needed — isolation is structural, not query-level
- No `profiles.username` — users belong to a tenant via `public.profiles`
- `short_code` is unique per schema, not globally — requires tenant-aware routing

#### Request Routing: Subdomain-Based

```
acme.short.link/abc123
  │                │
  │                └── short_code → queried in tenant_a7f3.links
  └── subdomain → KV lookup → schema_name = 'tenant_a7f3'
```

**Routing flow**:
1. Extract subdomain from request URL (`acme.short.link` → `acme`)
2. KV lookup: `subdomain_to_schema:acme` → `tenant_a7f3` (cached, sub-millisecond)
3. If KV miss → query `public.tenants WHERE subdomain = 'acme'` → cache in KV
4. All subsequent queries use fully-qualified names: `tenant_a7f3.links`, `tenant_a7f3.link_clicks`

**Why subdomain routing?**
- Clean URLs: `acme.short.link/abc123` vs `short.link/r/acme/abc123`
- No path conflict with API routes (`/api/*`)
- Natural multi-tenant UX (each customer has their own namespace)
- Cloudflare Workers can easily extract subdomain from `request.url`

#### Fully-Qualified Queries (No `search_path`)

Use schema-qualified table names instead of `SET search_path`. This avoids:
- Extra round-trip for `SET search_path` per request
- Connection pool fragmentation (different search_path = different pool entry)
- State leakage between requests

```typescript
// Redirect lookup
const result = await client.query(
  `SELECT original_url FROM ${schemaName}.links WHERE short_code = $1 AND is_active = true`,
  [shortCode]
);

// Analytics insert
await client.query(
  `INSERT INTO ${schemaName}.link_clicks (link_id, ip_hash, country_code, device_type, referrer)
   VALUES ($1, $2, $3, $4, $5)`,
  [linkId, ipHash, countryCode, deviceType, referrer]
);
```

**CRITICAL: SQL injection via schema name**. The schema name cannot be parameterized in PostgreSQL (`$1` doesn't work for identifiers). It must be validated against the KV cache (which is populated from `public.tenants`, a trusted source). Never accept raw schema names from user input.

```typescript
function validateSchemaName(raw: string, kvCache: Map<string, string>): string {
  // Must match a known tenant schema from KV cache (populated from public.tenants)
  const schema = kvCache.get(raw);
  if (!schema) throw new Error(`Unknown tenant: ${raw}`);
  // Extra safety: only allow alphanumeric + underscore
  if (!/^[a-z][a-z0-9_]*$/.test(schema)) throw new Error(`Invalid schema name: ${schema}`);
  return schema;
}
```

#### Tenant Lifecycle

**Provisioning (on sign-up / organization creation)**:
```sql
-- 1. Create tenant record in public schema
INSERT INTO public.tenants (schema_name, display_name, subdomain, owner_id)
VALUES ('tenant_a7f3', 'Acme Corp', 'acme', '<auth.user_id>');

-- 2. Create profile link
INSERT INTO public.profiles (id, tenant_id, role)
VALUES ('<auth.user_id>', '<tenant_id>', 'owner');

-- 3. Create tenant schema with all tables (run migration DDL)
CREATE SCHEMA tenant_a7f3;
-- ... CREATE TABLE statements for links, link_clicks, indexes ...

-- 4. Warm KV cache
-- KV: subdomain_to_schema:acme → tenant_a7f3
```

**Deletion (GDPR right to deletion / account closure)**:
```sql
-- 1. Remove tenant data — instant, atomic, complete
DROP SCHEMA tenant_a7f3 CASCADE;

-- 2. Remove registry entries
DELETE FROM public.profiles WHERE tenant_id = '<tenant_id>';
DELETE FROM public.tenants WHERE id = '<tenant_id>';

-- 3. Invalidate KV cache
-- KV: delete subdomain_to_schema:acme
```

#### Migration Strategy

Every schema change must be applied to ALL tenant schemas. Strategy:
1. **Template provisioning**: New tenants get the latest schema version automatically.
2. **Migration runner**: A Cron Trigger (Cloudflare Workers Cron) runs pending migrations on all active tenant schemas.
3. **Version tracking**: Each schema has a `_migrations` table tracking applied versions.

```
migrations/
├── 001_create_links.sql
├── 002_create_link_clicks.sql
├── 003_add_expires_at.sql
└── 004_add_is_active.sql
```

For MVP (few tenants), manual migration execution is acceptable. Automate before reaching 10+ tenants.

#### Short-Code Collisions: Per-Tenant Uniqueness

With schema-per-tenant + subdomain routing, short codes only need to be unique within their schema. `acme.short.link/abc123` and `beta.short.link/abc123` can both use `abc123` without conflict — they resolve to different schemas.

This means:
- No global `short_code` registry needed
- No cross-tenant collision checks
- nanoid at 6-7 characters is plenty for per-tenant uniqueness
- UNIQUE constraint + retry is sufficient (collision probability is ~1 in billions at 7 chars)

#### Trade-offs vs RLS-Based Multi-Tenancy

| Dimension | Schema-per-Tenant | RLS-Based |
|-----------|-------------------|-----------|
| **Isolation** | Structural (separate namespace) | Policy-based (WHERE clause) |
| **Deletion** | `DROP SCHEMA CASCADE` (instant) | Cascade DELETE across all tables (slow at scale) |
| **GDPR compliance** | Trivial (one command) | Complex (must verify all rows deleted) |
| **Migrations** | Run per schema (N times) | Run once (global) |
| **Cross-tenant queries** | Hard (UNION across schemas) | Trivial (single table) |
| **RLS policies** | Not needed | Required on every table |
| **Supabase Dashboard** | Only sees `public` schema | Full visibility |
| **Per-tenant backup** | `pg_dump --schema=tenant_x` | Filter by `user_id` |
| **Index efficiency** | Smaller per-tenant indexes | Large global indexes |
| **Short codes** | Unique per tenant | Globally unique |
| **Code complexity** | Schema name interpolation | Standard queries + RLS |

### 7.2 Feature Prioritization for MVP

| Feature | Priority | Rationale |
|---------|----------|-----------|
| Redirect (`/r/:code`) | P0 (MVP) | Core functionality |
| Link creation (API) | P0 (MVP) | Core functionality |
| Auth (Supabase JWT) | P0 (MVP) | Required for multi-tenant |
| Click tracking (basic) | P0 (MVP) | Core analytics |
| KV cache | P0 (MVP) | Required for redirect latency |
| Hyperdrive | P0 (MVP) | Required for DB connection pooling |
| Link listing (dashboard) | P1 (Post-MVP) | User needs to see their links |
| Link edit/delete | P1 (Post-MVP) | Basic management |
| Click analytics (dashboard) | P1 (Post-MVP) | Basic analytics |
| Rate limiting | P1 (Post-MVP) | Abuse protection |
| GDPR compliance | P1 (Post-MVP) | Legal requirement before public launch |
| Custom short codes | P2 | Nice to have |
| QR codes | P2 | Nice to have |
| Custom domains | P3 | Enterprise feature |
| API keys for programmatic access | P3 | Developer feature |

### 7.3 Free Tier vs Paid Tier Considerations

If planning for SaaS monetization:
- Free tier: 100 links, 10K clicks/month, basic analytics
- Pro tier: unlimited links, 100K clicks/month, advanced analytics, custom codes
- Enterprise: custom domains, API access, SLA

**Recommendation**: Don't over-engineer for monetization in MVP. Build the core with clean abstractions that allow tier limits to be added later.

---

## Approaches Considered

### Approach A: Single Worker Monolith
All routes in one Worker (`src/index.ts` with Hono router).
- **Pros**: Simple deployment, single codebase, easy to reason about
- **Cons**: No separation of concerns; risk of analytics code affecting redirect latency; harder to scale independently
- **Effort**: Low

### Approach B: Service-Bound Workers (Microservices)
Separate Workers for redirect, analytics, and API, connected via Service Bindings.
- **Pros**: Independent scaling, isolated failure domains, cleaner code
- **Cons**: Complex deployment, Service Binding overhead (minimal but present), harder local development
- **Effort**: Medium

### Approach C: Single Worker with Queue-Based Analytics
Single Worker handles all routes; click events go to a Queue, consumed by a separate Worker.
- **Pros**: Decoupled analytics, reliable event processing, single deployment unit for routing
- **Cons**: Requires Queue setup; adds infrastructure component
- **Effort**: Medium

**Recommendation**: **Approach A (Single Worker Monolith) with Hono router** for the MVP. It's the simplest path to a working product. The code structure can be clean enough with good module boundaries. Approach C (Queue) can be introduced as an optimization when click volume warrants it.

---

## Gap Summary

| # | Gap | Severity | Recommendation |
|---|-----|----------|----------------|
| 1 | No Hyperdrive for Supabase connection pooling | **CRITICAL** | Must configure Hyperdrive binding; direct connections cost 300-500ms |
| 2 | No short_code generation strategy | **CRITICAL** | Use nanoid with custom alphabet (7 chars), retry on UNIQUE violation; per-tenant uniqueness (non-global) |
| 3 | SQL injection risk via schema name interpolation | **CRITICAL** | Validate schema names against KV cache (populated from `public.tenants`); strict regex allowlist |
| 4 | `ip_address` stored in plaintext (GDPR) | **CRITICAL** | Hash IP with SHA-256 + per-tenant salt before storage; define retention policy |
| 5 | No open redirect validation | **CRITICAL** | Validate URL protocol, block localhost/private IPs |
| 6 | No `is_active` column | **HIGH** | Add BOOLEAN field to enable/disable links |
| 7 | No rate limiting strategy | **HIGH** | Use Cloudflare WAF rate limiting rules for MVP |
| 8 | `clicks_count` drift risk | **HIGH** | Use atomic UPDATE; add reconciliation Cron Trigger |
| 9 | No KV cache strategy specified | **HIGH** | Implement write-aside cache with 24h TTL; populate on creation. Also cache subdomain→schema mapping |
| 10 | `referer` column misspelling | **LOW** | Rename to `referrer` |
| 11 | Missing `expires_at` for time-limited links | **MEDIUM** | Add TIMESTAMPTZ field; check in redirect handler |
| 12 | No migration strategy for schema-per-tenant | **HIGH** | Template-based provisioning + Cron Trigger migration runner; `_migrations` tracking table per schema |
| 13 | No schema name validation in queries | **CRITICAL** | Never accept raw schema names from user input; validate against `public.tenants` + KV cache |
| 14 | No data retention policy for click data | **HIGH** | Implement 90-day retention; scheduled cleanup Cron Trigger per tenant |
| 15 | No abuse prevention (phishing/malware) | **HIGH** | Add URL blocklist; rate limit creation; manual reporting |

---

## Recommendations for Proposal Phase

1. **Adopt schema-per-tenant architecture** — `public` schema for tenant registry + auth mapping; per-tenant schemas for `links` and `link_clicks`
2. **Explicitly include Hyperdrive in the architecture** — it's not optional for Cloudflare Workers + Supabase
3. **Define the short_code generation strategy** — nanoid with custom alphabet (7 chars), collision handling; codes are per-tenant unique (not global)
4. **Implement subdomain-based routing** — `{tenant}.short.link/{code}` with KV-cached subdomain→schema mapping
5. **Add the shared schema tables**: `public.tenants` (registry), `public.profiles` (auth→tenant mapping)
6. **Add per-tenant schema fields**: `is_active`, `expires_at`, `updated_at` on `links`; `ip_hash`, `user_agent_summary`, `referrer` on `link_clicks`
7. **Add per-tenant indexes**: `idx_links_short_code`, `idx_links_created_at`, `idx_link_clicks_link_id`, `idx_link_clicks_created_at`, `idx_link_clicks_link_id_created_at`
8. **Implement IP hashing from day one** — SHA-256 with per-tenant salt before storage
9. **Validate schema names strictly** — only allow values from KV cache (populated from `public.tenants`); never accept raw input in SQL identifiers
10. **Specify KV cache strategy** — write-aside cache for short_code→URL (24h TTL) AND subdomain→schema (1h TTL); invalidation on link update
11. **Define rate limiting approach** — Cloudflare WAF rules for MVP
12. **Include observability config** — structured JSON logging, Workers traces
13. **Plan for Cron Triggers**: data retention cleanup per tenant, `clicks_count` reconciliation, schema migration runner
14. **Plan tenant lifecycle**: provisioning (CREATE SCHEMA + run DDL + warm KV), deletion (DROP SCHEMA CASCADE), suspension (toggle `public.tenants.is_active`)
15. **Validate scope**: schema-per-tenant from day one, defer QR codes, custom domains, and Durable Objects
16. **Testing**: configure `@cloudflare/vitest-pool-workers` for Worker tests; use Supabase local development for integration tests; test tenant isolation explicitly

---

## Risks

1. **Supabase cold start from Workers**: Even with Hyperdrive, the first query after a period of inactivity may see elevated latency. Mitigation: KV cache absorbs most redirect traffic.
2. **KV eventual consistency**: A link update followed immediately by a redirect might serve the old URL for up to 60 seconds. Mitigation: Acceptable for MVP; document the behavior.
3. **Supabase free tier limits**: 500MB database, 2GB bandwidth, 50K monthly active users. Mitigation: Monitor usage; upgrade to Pro if approaching limits.
4. **Single Worker deployment risk**: A bug in the analytics handler could affect the redirect handler. Mitigation: Thorough error isolation; `ctx.waitUntil()` catches and logs errors without propagating.
5. **`clicks_count` drift**: Under high concurrency, UPDATE contention could cause lost increments. Mitigation: Reconciliation job; Queue buffer in post-MVP.
6. **SQL injection via schema name**: Schema names are interpolated (can't be parameterized). Mitigation: Validate against KV cache (sourced from `public.tenants`); strict regex allowlist; never accept raw user input.
7. **Migration complexity at scale**: 100 tenants = 100 schema migrations. Mitigation: Template provisioning for new tenants; Cron Trigger migration runner; version tracking via `_migrations` table.
8. **Supabase Dashboard blind spot**: The Supabase table editor only shows `public` schema by default. Tenant schemas require direct SQL access. Mitigation: Document this; use `psql` or Supabase SQL Editor for tenant schema inspection.

---

## Ready for Proposal

**Yes**. The exploration has identified all critical gaps and trade-offs, now including the schema-per-tenant architecture decision. The proposal phase should incorporate:

- **Schema-per-tenant architecture** with `public` registry + per-tenant schemas for `links` and `link_clicks`
- **Subdomain-based routing** with KV-cached subdomain→schema mapping
- The corrected per-tenant schema with missing fields and indexes
- Explicit Hyperdrive and KV cache configuration (two cache namespaces: short_code and subdomain)
- Clear short_code generation and validation strategy (per-tenant uniqueness)
- Tenant lifecycle: provisioning (CREATE SCHEMA + DDL + KV warm), deletion (DROP SCHEMA CASCADE), suspension
- GDPR-compliant IP handling with per-tenant salt from day one
- Schema name validation against KV cache to prevent SQL injection
- Defined MVP scope with deferred features clearly listed
- Migration strategy for schema-per-tenant (template + Cron Trigger runner)
