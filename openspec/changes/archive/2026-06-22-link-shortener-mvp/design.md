# Design: Link Shortener MVP

> ## AMENDMENT — redirect status changed from 301 to 302 (post-archive)
>
> The body of this document is preserved exactly as written for the June 2026
> MVP and still shows **301** in the request-flow diagrams, the redirect
> handler sketch, and the failure-mode table. Those are left untouched on
> purpose: they are the historical record of what was designed and shipped at
> the time.
>
> **The implementation returns 302.** The operative requirement is in the live
> spec at `openspec/specs/link-shortener.md` (REQ-R001 and its scenarios);
> this amendment note is not itself normative.
>
> **Why the original 301 decision was wrong:**
>
> 1. **It contradicts the 24h KV TTL** this design already specifies for the
>    short-code cache. A 301 is cached permanently by browsers and CDNs with no
>    TTL mechanism, so the cache can never be brought back in sync with the
>    database.
> 2. **It contradicts REQ-L003**, which requires that inactive or expired links
>    stop redirecting. Under 301, a client that already cached the redirect
>    keeps following it after deactivation or expiry — permanently, with no way
>    to revoke it. Under 302 the client re-requests and the change takes effect
>    within the 24h TTL window.
> 3. **The NFC-tag use case is the worst case for 301**, because the tag
>    publisher cannot control the scanning client's cache.
>
> The usual SEO rationale for 301 does not apply: destinations are Google Maps
> review links and affiliate links, which are not indexed pages and carry no
> authority to consolidate. Request volume does not meaningfully change under
> 302, since KV already absorbs traffic for 24h and the database is queried
> only on a cache miss.

## 1. Architecture Overview

```
                        Cloudflare Edge
 ┌──────────────────────────────────────────────────────────────┐
 │                                                              │
 │  ┌──────────────────────────────────────────────────────────┐│
 │  │              Cloudflare Worker (Hono router)              ││
 │  │                                                          ││
 │  │  ┌──────────┐  ┌───────────────┐  ┌──────────────────┐  ││
 │  │  │ Handlers │  │   Middleware   │  │    Analytics     │  ││
 │  │  │ redirect │  │  auth (JWT)   │  │  ctx.waitUntil() │  ││
 │  │  │ landing  │  │  tenant (slug)│  │  → hyperdrive    │  ││
 │  │  │ /api/*   │  │  error (try/) │  │                  │  ││
 │  │  └────┬─────┘  └───────┬───────┘  └────────┬─────────┘  ││
 │  │       │                │                    │            ││
 │  └───────┼────────────────┼────────────────────┼────────────┘│
 │          │                │                    │              │
 │    ┌─────┴─────┐   ┌──────┴──────┐    ┌───────┴────────┐    │
 │    │  KV Cache │   │  KV Cache   │    │   Hyperdrive   │    │
 │    │ SHORT_URL │   │  TENANT     │    │ (conn. pool)   │    │
 │    │ code→URL  │   │ slug→schema │    └───────┬────────┘    │
 │    │ 24h TTL   │   │ 1h TTL      │            │              │
 │    └───────────┘   └─────────────┘            │              │
 └───────────────────────────────────────────────┼──────────────┘
                                                  │
                                     Supabase PostgreSQL
 ┌───────────────────────────────────────────────┼──────────────┐
 │                                                │              │
 │  ┌──────────────┐  ┌──────────────┐  ┌───────┴────────┐    │
 │  │   public     │  │  tenant_a7f3 │  │   analytics    │    │
 │  │   tenants    │  │   links      │  │  link_clicks   │    │
 │  │   profiles   │  │              │  │  (shared)      │    │
 │  └──────────────┘  └──────────────┘  └────────────────┘    │
 │                                                              │
 │  ┌──────────────┐  ┌──────────────┐                         │
 │  │  tenant_b12  │  │   (...N)     │  + auth.users (Supabase)│
 │  │   links      │  │              │                         │
 │  └──────────────┘  └──────────────┘                         │
 └──────────────────────────────────────────────────────────────┘
```

### Component Responsibilities

| Component | Role |
|-----------|------|
| **Cloudflare Worker** | Single entry point via Hono router. Path routing, JWT validation, tenant resolution, cache orchestration, response construction. |
| **KV `SHORT_URL_CACHE`** | `{tenant_slug}:{short_code}` → `original_url`. 24h TTL. Write-aside on redirect miss, populated on link creation. |
| **KV `TENANT_CACHE`** | `{tenant_slug}` → `schema_name`. 1h TTL. Populated on redirect/API when slug resolved from `public.tenants`. |
| **Hyperdrive** | Regional connection pooling to Supabase PostgreSQL. Eliminates per-request TCP+TLS overhead. `node:pg` Client instantiated per request. |
| **Supabase `public`** | Tenant registry (`tenants`) and user-to-tenant mapping (`profiles`). Shared across all tenants. |
| **Supabase `tenant_{id}`** | Per-tenant `links` table. Structural isolation — no RLS needed. Schema-per-tenant is the isolation boundary. |
| **Supabase `analytics`** | Shared `link_clicks` table with `tenant_id` column. Cross-tenant visibility for admin queries. |
| **Supabase Auth** | Manages users. JWT validated in Worker middleware. `auth.users` shared. |

### Data Flow Summary

1. **Redirect (cache hit)**: Client → Worker → `TENANT_CACHE.get(slug)` → `SHORT_URL_CACHE.get(code)` → HIT → `ctx.waitUntil(trackClick)` → 301
2. **Redirect (cache miss)**: Client → Worker → KV misses → Hyperdrive queries `public.tenants` + `tenant_x.links` → populates both KV → `ctx.waitUntil(trackClick)` → 301
3. **Link creation**: Client → Worker → JWT validation → tenant resolution → URL validation → 30-link check → nanoid generation → `INSERT tenant_x.links` → `KV.put(code, url)` → 201
4. **Tenant provisioning**: Supabase Auth signup → Worker → slug validation → `INSERT public.tenants` + `public.profiles` → `CREATE SCHEMA tenant_x` → DDL execution → `KV.put(slug, schema)` → 201
5. **Analytics tracking**: After 301 sent → `ctx.waitUntil`: extract CF headers → hash IP → `INSERT analytics.link_clicks` → `UPDATE tenant_x.links SET clicks_count = clicks_count + 1`

---

## 2. Database Design

### 2.1 `public` Schema — Tenant Registry + User Mapping

```sql
-- Shared schema: created once at project initialization
CREATE SCHEMA IF NOT EXISTS public;

-- Tenant registry: one row per provisioned tenant
CREATE TABLE public.tenants (
    id           UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    schema_name  TEXT UNIQUE NOT NULL,            -- e.g. 'tenant_a7f3d2b1'
    display_name TEXT NOT NULL,                    -- e.g. 'Acme Corp'
    subdomain    TEXT UNIQUE NOT NULL,             -- e.g. 'acme' (path segment)
    owner_id     UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    is_active    BOOLEAN DEFAULT true,
    created_at   TIMESTAMPTZ DEFAULT now()
);

-- User-to-tenant mapping: one profile per user
CREATE TABLE public.profiles (
    id         UUID REFERENCES auth.users(id) ON DELETE CASCADE PRIMARY KEY,
    tenant_id  UUID REFERENCES public.tenants(id) ON DELETE CASCADE NOT NULL,
    role       TEXT DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Indexes
CREATE INDEX idx_tenants_subdomain ON public.tenants(subdomain)
    WHERE is_active = true;  -- Partial: only active tenants for lookups
CREATE INDEX idx_tenants_owner ON public.tenants(owner_id);
CREATE INDEX idx_profiles_tenant ON public.profiles(tenant_id);
```

**Index rationale**:
- `idx_tenants_subdomain`: Primary lookup path during tenant resolution. Partial index excludes inactive tenants, reducing index size.
- `idx_tenants_owner`: Tenant deletion flows need to verify ownership (find tenant by `owner_id`).
- `idx_profiles_tenant`: Find all users belonging to a tenant (admin queries, deletion cascade verification).

### 2.2 Per-Tenant Schema Template (e.g., `tenant_a7f3d2b1`)

```sql
-- Provisioned by the Worker on sign-up (see Section 4.13)

CREATE SCHEMA tenant_{id};

CREATE TABLE tenant_{id}.links (
    id           UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    original_url TEXT NOT NULL,
    short_code   TEXT NOT NULL,
    title        TEXT,                              -- Optional display name
    clicks_count INTEGER DEFAULT 0 NOT NULL,
    is_active    BOOLEAN DEFAULT true NOT NULL,
    expires_at   TIMESTAMPTZ,                       -- NULL = never expires
    created_at   TIMESTAMPTZ DEFAULT now() NOT NULL,
    updated_at   TIMESTAMPTZ DEFAULT now() NOT NULL
);

-- Per-tenant uniqueness: short_code must be unique within the schema
-- Two tenants CAN both use 'abc123' (different schemas = no collision)
CREATE UNIQUE INDEX idx_links_short_code ON tenant_{id}.links(short_code);
CREATE INDEX idx_links_created_at ON tenant_{id}.links(created_at DESC);
CREATE INDEX idx_links_active_expires ON tenant_{id}.links(is_active, expires_at)
    WHERE is_active = true;  -- Redirect lookup optimization

-- Migration tracking table (one per schema)
CREATE TABLE tenant_{id}._migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    applied_at TIMESTAMPTZ DEFAULT now()
);
```

**Why no `user_id` column**: The schema IS the tenant boundary. Structural isolation eliminates the need for per-row ownership columns. RLS policies are unnecessary — a query either targets the right schema or it doesn't.

**Short code uniqueness**: `UNIQUE` on `short_code` is per-schema. Collision probability with nanoid at 7 chars (~32B combinations) is effectively zero within a single tenant, but the constraint + retry handles it gracefully.

### 2.3 `analytics` Schema — Shared Click Tracking

```sql
-- Shared schema: created once at project initialization
CREATE SCHEMA IF NOT EXISTS analytics;

CREATE TABLE analytics.link_clicks (
    id               UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    tenant_id        UUID REFERENCES public.tenants(id) ON DELETE CASCADE NOT NULL,
    link_id          UUID NOT NULL,                -- No FK: links live in per-tenant schemas
    ip_hash          TEXT,                          -- SHA-256(ip + per-tenant salt), NULL if missing
    user_agent_summary TEXT,                        -- e.g. "Chrome/Android", NOT raw UA string
    device_type      TEXT,                          -- 'mobile', 'desktop', 'tablet', or NULL
    country_code     TEXT,                          -- ISO 3166-1 alpha-2 from CF-IPCountry
    referrer         TEXT,                          -- Stripped of query params, or NULL
    created_at       TIMESTAMPTZ DEFAULT now()
);

-- Indexes
CREATE INDEX idx_link_clicks_tenant ON analytics.link_clicks(tenant_id);
CREATE INDEX idx_link_clicks_link ON analytics.link_clicks(link_id);
CREATE INDEX idx_link_clicks_created ON analytics.link_clicks(created_at DESC);
CREATE INDEX idx_link_clicks_link_time ON analytics.link_clicks(link_id, created_at DESC);

-- Migration tracking
CREATE TABLE analytics._migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    applied_at TIMESTAMPTZ DEFAULT now()
);
```

**Why no FK on `link_id`**: `links` tables are in per-tenant schemas (`tenant_x.links`). PostgreSQL foreign keys cannot reference tables across an unknown set of schemas. The `link_id` is a logical reference validated by application code (the redirect handler only inserts clicks for links it successfully resolved). Cascade deletion is handled by the deprovisioning process (Section 3.6), not by FK.

### 2.4 Migration Version Tracking

Each schema (public, analytics, and every per-tenant schema) contains a `_migrations` table. This enables:
- Idempotent provisioning: new tenants get the latest schema version.
- Cron-based migration runner (post-MVP): applies pending migrations to all active tenant schemas.
- Audit trail: each `_migrations` row records when a migration was applied.

Per-tenant migration DDL files live at `supabase/migrations/tenant/`:
```
supabase/migrations/tenant/
├── 001_create_links.sql
├── 002_create_migrations_table.sql
└── 003_add_expires_at.sql     (future)
```

---

## 3. Sequence Diagrams

### 3.1 Redirect — KV Cache Hit (Best Case)

```
Client          Worker              SHORT_URL_CACHE  TENANT_CACHE    Hyperdrive    Supabase
  │                │                      │               │               │            │
  │ GET /r/acme/   │                      │               │               │            │
  │   abc123       │                      │               │               │            │
  │───────────────>│                      │               │               │            │
  │                │                      │               │               │            │
  │                │ 1. extract slug      │               │               │            │
  │                │    "acme" from path  │               │               │            │
  │                │                      │               │               │            │
  │                │ 2. TENANT_CACHE      │               │               │            │
  │                │    .get("acme")      │               │               │            │
  │                │─────────────────────────────────────>│               │            │
  │                │    HIT: "tenant_a7f3"│               │               │            │
  │                │<─────────────────────────────────────│               │            │
  │                │                      │               │               │            │
  │                │ 3. validate schema   │               │               │            │
  │                │    regex + kv check  │               │               │            │
  │                │                      │               │               │            │
  │                │ 4. SHORT_URL_CACHE   │               │               │            │
  │                │    .get("acme:abc123")│              │               │            │
  │                │─────────────────────>│               │               │            │
  │                │    HIT: "https://..." │               │               │            │
  │                │<─────────────────────│               │               │            │
  │                │                      │               │               │            │
  │                │ 5. Response.redirect │               │               │            │
  │                │    (originalUrl, 301)│               │               │            │
  │                │                      │               │               │            │
  │                │ 6. ctx.waitUntil(    │               │               │            │
  │                │      trackClick(...))│               │               │            │
  │                │    ──────────────────────────────────────────────────> INSERT +    │
  │                │    (fire-and-forget, │               │               │   UPDATE     │
  │                │     after response)  │               │               │            │
  │                │                      │               │               │            │
  │  HTTP 301      │                      │               │               │            │
  │  Location:     │                      │               │               │            │
  │  https://...   │                      │               │               │            │
  │<───────────────│                      │               │               │            │
  │                │                      │               │               │            │
```

### 3.2 Redirect — KV Cache Miss (Database Fallback)

```
Client          Worker              SHORT_URL_CACHE  TENANT_CACHE    Hyperdrive    Supabase
  │                │                      │               │               │            │
  │ GET /r/acme/   │                      │               │               │            │
  │   xyz999       │                      │               │               │            │
  │───────────────>│                      │               │               │            │
  │                │ 1. extract slug      │               │               │            │
  │                │    "acme" from path  │               │               │            │
  │                │                      │               │               │            │
  │                │ 2. TENANT_CACHE      │               │               │            │
  │                │    .get("acme")      │               │               │            │
  │                │─────────────────────────────────────>│               │            │
  │                │    HIT: "tenant_a7f3"│               │               │            │
  │                │<─────────────────────────────────────│               │            │
  │                │                      │               │               │            │
  │                │ 3. SHORT_URL_CACHE   │               │               │            │
  │                │    .get("acme:xyz999")│              │               │            │
  │                │─────────────────────>│               │               │            │
  │                │    MISS              │               │               │            │
  │                │<─────────────────────│               │               │            │
  │                │                      │               │               │            │
  │                │ 4. Query DB          │               │               │            │
  │                │    SELECT original_url│              │               │            │
  │                │    FROM tenant_a7f3  │               │               │            │
  │                │    .links WHERE      │               │               │            │
  │                │    short_code=$1 AND │               │               │            │
  │                │    is_active=true    │               │               │            │
  │                │─────────────────────────────────────────────────────>│            │
  │                │    Row found:         │               │               │            │
  │                │    "https://..."     │               │               │            │
  │                │<─────────────────────────────────────────────────────│            │
  │                │                      │               │               │            │
  │                │ 5. ctx.waitUntil(    │               │               │            │
  │                │    KV.put("acme:xyz999",│             │               │            │
  │                │    url, {ttl:86400}))│               │               │            │
  │                │─────────────────────>│               │               │            │
  │                │                      │               │               │            │
  │                │ 6. Response.redirect │               │               │            │
  │                │    (originalUrl, 301)│               │               │            │
  │                │                      │               │               │            │
  │                │ 7. ctx.waitUntil(    │               │               │            │
  │                │      trackClick(...))│               │               │            │
  │                │    ──────────────────────────────────────────────────>            │
  │                │                      │               │               │            │
  │  HTTP 301      │                      │               │               │            │
  │<───────────────│                      │               │               │            │
```

### 3.3 Redirect — Tenant Resolution Miss

```
Client          Worker              TENANT_CACHE    Hyperdrive         Supabase
  │                │                      │               │                 │
  │ GET /r/newco/  │                      │               │                 │
  │   abc123       │                      │               │                 │
  │───────────────>│                      │               │                 │
  │                │ 1. extract slug      │               │                 │
  │                │    "newco" from path │               │                 │
  │                │                      │               │                 │
  │                │ 2. TENANT_CACHE      │               │                 │
  │                │    .get("newco")     │               │                 │
  │                │─────────────────────>│               │                 │
  │                │    MISS              │               │                 │
  │                │<─────────────────────│               │                 │
  │                │                      │               │                 │
  │                │ 3. Query registry    │               │                 │
  │                │    SELECT schema_name│               │                 │
  │                │    FROM public.tenants│              │                 │
  │                │    WHERE subdomain=$1│               │                 │
  │                │    AND is_active=true│               │                 │
  │                │─────────────────────────────────────>│                 │
  │                │    Row: "tenant_b12d" │              │                 │
  │                │    <─────────────────────────────────────│              │
  │                │                      │               │                 │
  │                │ 4. ctx.waitUntil(    │               │                 │
  │                │    KV.put("newco",   │               │                 │
  │                │    "tenant_b12d",    │               │                 │
  │                │    {ttl:3600}))      │               │                 │
  │                │─────────────────────>│               │                 │
  │                │                      │               │                 │
  │                │ 5. Continue to       │               │                 │
  │                │    redirect flow     │               │                 │
  │                │    (Section 3.1/3.2) │               │                 │
```

### 3.4 Link Creation

```
Client          Worker              SHORT_URL_CACHE  Hyperdrive    Supabase
  │                │                      │               │              │
  │ POST /api/links│                      │               │              │
  │ Authorization: │                      │               │              │
  │ Bearer <JWT>   │                      │               │              │
  │ { original_url │                      │               │              │
  │   : "https://..│                      │               │              │
  │   example.com"}│                      │               │              │
  │───────────────>│                      │               │              │
  │                │                      │               │              │
  │                │ 1. auth middleware   │               │              │
  │                │    validate JWT via  │               │              │
  │                │    Supabase Auth     │               │              │
  │                │    → userId, email   │               │              │
  │                │                      │               │              │
  │                │ 2. tenant middleware │               │              │
  │                │    SELECT schema_name│               │              │
  │                │    FROM public.      │               │              │
  │                │    profiles JOIN     │               │              │
  │                │    tenants WHERE     │               │              │
  │                │    profiles.id=$1    │               │              │
  │                │─────────────────────────────────────>│              │
  │                │    → schema_name     │               │              │
  │                │    <─────────────────────────────────────│              │
  │                │                      │               │              │
  │                │ 3. validate URL      │               │              │
  │                │    protocol: http/https│             │              │
  │                │    block localhost    │               │              │
  │                │    block private IPs  │               │              │
  │                │    max 2048 chars    │               │              │
  │                │                      │               │              │
  │                │ 4. check 30-link limit│              │              │
  │                │    SELECT COUNT(*)   │               │              │
  │                │    FROM tenant_x.links│              │              │
  │                │    WHERE is_active=true│             │              │
  │                │─────────────────────────────────────>│              │
  │                │    count < 30 ✓      │               │              │
  │                │    <─────────────────────────────────────│              │
  │                │                      │               │              │
  │                │ 5. nanoid(7) → code  │               │              │
  │                │                      │               │              │
  │                │ 6. INSERT INTO       │               │              │
  │                │    tenant_x.links    │               │              │
  │                │    (original_url,    │               │              │
  │                │     short_code)      │               │              │
  │                │    ON CONFLICT       │               │              │
  │                │    (short_code)      │               │              │
  │                │    DO NOTHING        │               │              │
  │                │    (retry up to 3x)  │               │              │
  │                │─────────────────────────────────────>│              │
  │                │    INSERT OK         │               │              │
  │                │    <─────────────────────────────────────│              │
  │                │                      │               │              │
  │                │ 7. ctx.waitUntil(    │               │              │
  │                │    KV.put(           │               │              │
  │                │     "acme:abc123",   │               │              │
  │                │     original_url,    │               │              │
  │                │     {ttl:86400}))    │               │              │
  │                │─────────────────────>│               │              │
  │                │                      │               │              │
  │  HTTP 201      │                      │               │              │
  │  { id,         │                      │               │              │
  │    short_code, │                      │               │              │
  │    original_url,│                      │               │              │
  │    short_url,  │                      │               │              │
  │    created_at }│                      │               │              │
  │<───────────────│                      │               │              │
```

### 3.5 Tenant Provisioning

```
Client (browser)   Supabase Auth    Worker            Hyperdrive      Supabase
  │                      │             │                    │              │
  │ 1. Sign-up form      │             │                    │              │
  │    (email, password, │             │                    │              │
  │     subdomain slug)  │             │                    │              │
  │─────────────────────>│             │                    │              │
  │    auth.users INSERT │             │                    │              │
  │    → JWT returned    │             │                    │              │
  │<─────────────────────│             │                    │              │
  │                      │             │                    │              │
  │ 2. POST /api/tenants │             │                    │              │
  │    Authorization:    │             │                    │              │
  │    Bearer <JWT>      │             │                    │              │
  │    { subdomain:      │             │                    │              │
  │      "acme-corp",    │             │                    │              │
  │      display_name:   │             │                    │              │
  │      "Acme Corp" }   │             │                    │              │
  │─────────────────────────────────────>│                    │              │
  │                      │             │                    │              │
  │                      │             │ 3. validate slug   │              │
  │                      │             │    regex, no reserved│             │
  │                      │             │    words, uniqueness│             │
  │                      │             │    check via DB     │              │
  │                      │             │───────────────────>│              │
  │                      │             │    Available ✓      │              │
  │                      │             │<───────────────────│              │
  │                      │             │                    │              │
  │                      │             │ 4. BEGIN           │              │
  │                      │             │    INSERT public    │              │
  │                      │             │    .tenants         │              │
  │                      │             │    (schema_name,    │              │
  │                      │             │     display_name,   │              │
  │                      │             │     subdomain,      │              │
  │                      │             │     owner_id)       │              │
  │                      │             │───────────────────>│              │
  │                      │             │    → tenant_id      │              │
  │                      │             │    <───────────────────│              │
  │                      │             │                    │              │
  │                      │             │    INSERT public    │              │
  │                      │             │    .profiles        │              │
  │                      │             │    (id, tenant_id,  │              │
  │                      │             │     role='owner')   │              │
  │                      │             │───────────────────>│              │
  │                      │             │    OK               │              │
  │                      │             │    <───────────────────│              │
  │                      │             │                    │              │
  │                      │             │    CREATE SCHEMA    │              │
  │                      │             │    tenant_{id}      │              │
  │                      │             │───────────────────>│              │
  │                      │             │    OK               │              │
  │                      │             │    <───────────────────│              │
  │                      │             │                    │              │
  │                      │             │    Run DDL          │              │
  │                      │             │    (CREATE TABLE    │              │
  │                      │             │     links, indexes, │              │
  │                      │             │     _migrations)    │              │
  │                      │             │───────────────────>│              │
  │                      │             │    OK               │              │
  │                      │             │    <───────────────────│              │
  │                      │             │    COMMIT           │              │
  │                      │             │                    │              │
  │                      │             │ 5. ctx.waitUntil(   │              │
  │                      │             │    KV.put(slug,     │              │
  │                      │             │    schema_name,     │              │
  │                      │             │    {ttl:3600}))     │              │
  │                      │             │                    │              │
  │  HTTP 201           │             │                    │              │
  │  { tenant_id,       │             │                    │              │
  │    subdomain,       │             │                    │              │
  │    schema_name }    │             │                    │              │
  │<─────────────────────────────────────│                    │              │
```

### 3.6 Tenant Deletion

```
Admin/Owner       Worker            KV CACHE    Hyperdrive      Supabase     Supabase Auth
  │                  │                  │            │               │              │
  │ DELETE /api/     │                  │            │               │              │
  │ tenants/:id      │                  │            │               │              │
  │ Authorization:   │                  │            │               │              │
  │ Bearer <JWT>     │                  │            │               │              │
  │─────────────────>│                  │            │               │              │
  │                  │                  │            │               │              │
  │                  │ 1. JWT validation│            │               │              │
  │                  │    → userId      │            │               │              │
  │                  │                  │            │               │              │
  │                  │ 2. Verify ownership│           │               │              │
  │                  │    SELECT owner_id│            │               │              │
  │                  │    FROM public    │            │               │              │
  │                  │    .tenants       │            │               │              │
  │                  │    WHERE id=$1    │            │               │              │
  │                  │──────────────────────────────────────────────>│              │
  │                  │    owner_id === userId ✓         │               │              │
  │                  │    (also get schema_name,        │               │              │
  │                  │     subdomain)       │            │               │              │
  │                  │    <──────────────────────────────────────────────│              │
  │                  │                  │            │               │              │
  │                  │ 3. BEGIN          │            │               │              │
  │                  │    DROP SCHEMA    │            │               │              │
  │                  │    tenant_x       │            │               │              │
  │                  │    CASCADE        │            │               │              │
  │                  │    (removes links │            │               │              │
  │                  │     table, indexes,│            │               │              │
  │                  │     _migrations)  │            │               │              │
  │                  │──────────────────────────────────────────────>│              │
  │                  │    OK             │            │               │              │
  │                  │                  │            │               │              │
  │                  │    DELETE FROM    │            │               │              │
  │                  │    analytics      │            │               │              │
  │                  │    .link_clicks   │            │               │              │
  │                  │    WHERE          │            │               │              │
  │                  │    tenant_id=$1   │            │               │              │
  │                  │──────────────────────────────────────────────>│              │
  │                  │    OK             │            │               │              │
  │                  │                  │            │               │              │
  │                  │    DELETE FROM    │            │               │              │
  │                  │    public.profiles│            │               │              │
  │                  │    WHERE          │            │               │              │
  │                  │    tenant_id=$1   │            │               │              │
  │                  │──────────────────────────────────────────────>│              │
  │                  │    OK             │            │               │              │
  │                  │                  │            │               │              │
  │                  │    DELETE FROM    │            │               │              │
  │                  │    public.tenants │            │               │              │
  │                  │    WHERE id=$1    │            │               │              │
  │                  │──────────────────────────────────────────────>│              │
  │                  │    OK             │            │               │              │
  │                  │    COMMIT         │            │               │              │
  │                  │                  │            │               │              │
  │                  │ 4. Delete Auth user│            │               │              │
  │                  │    (service_role) │            │               │              │
  │                  │──────────────────────────────────────────────────────────────>│
  │                  │    OK             │            │               │              │
  │                  │                  │            │               │              │
  │                  │ 5. KV.delete(     │            │               │              │
  │                  │    subdomain)     │            │               │              │
  │                  │─────────────────>│            │               │              │
  │                  │                  │            │               │              │
  │  HTTP 204       │                  │            │               │              │
  │<─────────────────│                  │            │               │              │
```

### 3.7 Analytics Tracking (`ctx.waitUntil`)

```
Worker                          Hyperdrive              Supabase
  │                                  │                      │
  │ Response.redirect(301)          │                      │
  │ already sent to client          │                      │
  │                                  │                      │
  │ ctx.waitUntil(                   │                      │
  │   trackClick(code, req, env)     │                      │
  │ )                                │                      │
  │  │                               │                      │
  │  │ 1. Extract from request       │                      │
  │  │    - CF-Connecting-IP         │                      │
  │  │    - CF-IPCountry             │                      │
  │  │    - User-Agent → summary     │                      │
  │  │    - Referer → strip qs       │                      │
  │  │    - CF-Device-Type header    │                      │
  │  │                               │                      │
  │  │ 2. Hash IP                    │                      │
  │  │    SHA-256(ip + perTenantSalt)│                      │
  │  │                               │                      │
  │  │ 3. INSERT INTO                │                      │
  │  │    analytics.link_clicks      │                      │
  │  │    (tenant_id, link_id,       │                      │
  │  │     ip_hash, user_agent_      │                      │
  │  │     summary, device_type,     │                      │
  │  │     country_code, referrer)   │                      │
  │  │    VALUES ($1..$7)            │                      │
  │  │──────────────────────────────>│                      │
  │  │    INSERT OK                   │                      │
  │  │<──────────────────────────────│                      │
  │  │                               │                      │
  │  │ 4. UPDATE tenant_x.links      │                      │
  │  │    SET clicks_count =         │                      │
  │  │        clicks_count + 1       │                      │
  │  │    WHERE short_code = $1      │                      │
  │  │──────────────────────────────>│                      │
  │  │    UPDATE OK                   │                      │
  │  │<──────────────────────────────│                      │
  │  │                               │                      │
  │  │ On ANY error:                 │                      │
  │  │   catch → structured log      │                      │
  │  │   NEVER propagate             │                      │
  │  │   NEVER affect redirect       │                      │
  │  └─ (done, no client impact)    │                      │
```

---

## 4. Component Design

### 4.1 `src/router.ts` — Hono Route Definitions

**Purpose**: Central route registry. Maps HTTP methods and paths to handlers, applies middleware chains.

**Input/Output**:
```typescript
// Entry point: exported default fetch handler
import { Hono } from "hono";
import { Env } from "../worker-configuration"; // Generated by wrangler types

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const app = new Hono<{ Bindings: Env }>();
    // Routes registered below
    return app.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
```

**Dependencies**: `hono`, all handlers, all middleware.

**Route table**:
| Method | Path | Middleware | Handler |
|--------|------|-----------|---------|
| `GET` | `/` | errorHandler | `landing.ts` |
| `GET` | `/r/:tenant/:code` | errorHandler | `redirect.ts` |
| `POST` | `/api/links` | errorHandler, auth | `api/links.ts` |
| `POST` | `/api/tenants` | errorHandler, auth | `api/tenants.ts` (provision) |
| `DELETE` | `/api/tenants/:id` | errorHandler, auth | `api/tenants.ts` (deprovision) |

**Implementation notes**: Use `app.route()` for logical grouping. Error handler wraps all routes as outermost middleware. Hono handles parameter extraction (`c.req.param("tenant")`).

---

### 4.2 `src/handlers/redirect.ts` — Redirect Handler

**Purpose**: Resolve `GET /r/:tenant/:code` to a 301 redirect with cache-first strategy and fire-and-forget analytics.

**Input/Output**:
```typescript
interface RedirectContext {
  tenant: string;      // path segment
  code: string;        // path segment
}

// Returned to client: HTTP 301 | 404 | 410 | 503
```

**Dependencies**: `cache/shortcode.ts`, `cache/tenant.ts`, `db/client.ts`, `db/schema.ts`, `analytics/tracker.ts`, `tenants/resolve.ts`
**Bindings**: `SHORT_URL_CACHE`, `TENANT_CACHE`, `HYPERDRIVE`

**Implementation notes**:
1. Extract `tenant` and `code` from `c.req.param()`.
2. Resolve tenant slug → schema name via `resolveTenantSchema(tenant, env)`.
3. Generate cache key: `${tenant_slug}:${short_code}`.
4. KV get → hit: return 301 + `ctx.waitUntil(trackClick)`.
5. KV miss → Hyperdrive query `tenant_x.links` → evaluate `is_active` and `expires_at` → miss or inactive → 404 / 410.
6. On DB hit: `ctx.waitUntil(KV.put)` + `ctx.waitUntil(trackClick)` + return 301.
7. Never destructure `ctx` — use `ctx.waitUntil()` directly.

---

### 4.3 `src/handlers/landing.ts` — Static Landing Page

**Purpose**: Serve lightweight HTML page at root path with service name, description, and Supabase Auth sign-up/login links.

**Input/Output**: No input → `Response` with `Content-Type: text/html`.

**Dependencies**: None (pure string literal). No external `<script>`, no CSS frameworks.

**Implementation notes**: Return inline HTML string. Responsive via `<meta name="viewport">` and basic CSS media queries. Links to Supabase Auth URLs constructed from `env.SUPABASE_URL`.

---

### 4.4 `src/api/links.ts` — Link Creation

**Purpose**: Handle `POST /api/links` — validate input, enforce limits, generate short code, persist, warm cache.

**Input/Output**:
```typescript
// Request body
interface CreateLinkRequest {
  original_url: string;
  title?: string;
  expires_at?: string;  // ISO 8601
}

// Response body
interface CreateLinkResponse {
  id: string;
  short_code: string;
  original_url: string;
  short_url: string;
  title: string | null;
  expires_at: string | null;
  created_at: string;
}
```

**Dependencies**: `utils/validation.ts`, `utils/short-code.ts`, `db/client.ts`, `db/schema.ts`, `cache/shortcode.ts`, `middleware/tenant.ts`
**Bindings**: `HYPERDRIVE`, `SHORT_URL_CACHE`

**Implementation notes**:
1. JWT already validated by auth middleware; user available via `c.get("user")`.
2. Tenant schema resolved by tenant middleware; available via `c.get("tenantSchema")`.
3. Validate `original_url` (protocol, localhost block, private IP block, max 2048 chars).
4. Count active links: `SELECT COUNT(*) FROM {schema}.links WHERE is_active = true`. Reject if ≥ 30.
5. Generate nanoid 7 chars. Loop: `INSERT ... ON CONFLICT (short_code) DO NOTHING`. If `rowCount === 0`, retry up to 3 times.
6. Construct `short_url`: `https://{SHORT_URL_DOMAIN}/r/{tenant_slug}/{short_code}`.
7. `ctx.waitUntil(KV.put(key, original_url, { expirationTtl: 86400 }))`.
8. Return 201 with full link resource.

---

### 4.5 `src/api/tenants.ts` — Tenant Management

**Purpose**: Handle `POST /api/tenants` (provisioning) and `DELETE /api/tenants/:id` (deprovisioning).

**Input/Output**:
```typescript
// Provision request
interface ProvisionTenantRequest {
  subdomain: string;       // 3-30 chars, alphanumeric + hyphens
  display_name: string;    // 1-100 chars
}

// Provision response
interface ProvisionTenantResponse {
  tenant_id: string;
  subdomain: string;
  schema_name: string;
  created_at: string;
}
```

**Dependencies**: `utils/validation.ts`, `db/client.ts`, `db/schema.ts`, `cache/tenant.ts`, `tenants/provision.ts`, `tenants/deprovision.ts`
**Bindings**: `HYPERDRIVE`, `TENANT_CACHE`, `SUPABASE_SERVICE_ROLE_KEY` (secret)

**Implementation notes**:
- **POST**: Validate slug (regex `^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$`, reserved word check, uniqueness via `public.tenants`). Then delegate to `provisionTenant()`. Wrap in transaction: INSERT tenants → INSERT profiles → CREATE SCHEMA → run DDL → COMMIT. On failure, ROLLBACK.
- **DELETE**: Verify JWT `userId === tenant.owner_id` (or admin). Delegate to `deprovisionTenant()`. Steps: DROP SCHEMA CASCADE → DELETE analytics.link_clicks → DELETE profiles → DELETE tenants → KV.delete(slug) → DELETE auth.users (via Supabase Admin API with service_role key). KV deletion failure is non-fatal (keys expire via TTL).

---

### 4.6 `src/middleware/auth.ts` — JWT Validation

**Purpose**: Validate Supabase JWT from `Authorization: Bearer <token>`. Reject with 401 if missing, expired, or invalid. Attach `{ userId, email }` to Hono context.

**Input/Output**:
```typescript
// Injected into Hono context
interface AuthenticatedUser {
  userId: string;
  email: string;
}

// Middleware: validates token, sets c.set("user", user) or returns 401
```

**Dependencies**: `jose` (JWT library), `SUPABASE_JWT_SECRET` (secret)
**Bindings**: `SUPABASE_JWT_SECRET`

**Implementation notes**:
1. Extract token from header: `c.req.header("Authorization")?.replace("Bearer ", "")`.
2. Verify signature using Supabase JWT secret (`jose.jwtVerify`). Validate `exp` and `aud` claims.
3. On failure: structured JSON error log + 401 response with `{ error: "unauthenticated" }`.
4. On success: `c.set("user", { userId: payload.sub, email: payload.email })`.
5. Skip validation for public routes (`GET /`, `GET /r/*`).

---

### 4.7 `src/middleware/tenant.ts` — Tenant Resolution (Pluggable)

**Purpose**: Resolve the current tenant's schema name. Strategy interface allows swapping path-based resolution for subdomain-based without touching handlers.

**Input/Output**:
```typescript
// Strategy interface
interface TenantResolutionStrategy {
  extractTenantSlug(c: Context): string;
}

// Path-based strategy (MVP)
class PathBasedStrategy implements TenantResolutionStrategy {
  extractTenantSlug(c: Context): string {
    return c.req.param("tenant");  // /r/{tenant}/{code}
  }
}

// Future: subdomain-based strategy
// class SubdomainStrategy implements TenantResolutionStrategy {
//   extractTenantSlug(c: Context): string {
//     return new URL(c.req.url).hostname.split(".")[0];
//   }
// }

// Injected into Hono context
interface TenantContext {
  tenantSlug: string;
  schemaName: string;
}
```

**Dependencies**: `cache/tenant.ts`, `db/client.ts`
**Bindings**: `TENANT_CACHE`, `HYPERDRIVE`

**Implementation notes**:
1. Extract slug via configured strategy.
2. Check `TENANT_CACHE` → hit: validate with regex `^[a-z][a-z0-9_]*$`, use it.
3. Cache miss: query `public.tenants WHERE subdomain = $1 AND is_active = true`.
4. Found: `ctx.waitUntil(KV.put(slug, schema_name, { expirationTtl: 3600 }))` + store in context.
5. Not found: return 404 with `{ error: "tenant_not_found" }`.
6. Schema name is validated against KV cache (whitelist) + regex before use in SQL.

---

### 4.8 `src/analytics/tracker.ts` — Click Tracking

**Purpose**: Record click events asynchronously via `ctx.waitUntil()`. Extract Cloudflare headers, hash IP, INSERT into `analytics.link_clicks`, UPDATE `clicks_count`.

**Input/Output**:
```typescript
interface TrackClickParams {
  tenantId: string;
  schemaName: string;
  linkId: string;
  shortCode: string;
  request: Request;
}

// No return value (void). Errors are caught and logged, never propagated.
```

**Dependencies**: `db/client.ts`, `db/schema.ts`, `utils/validation.ts`
**Bindings**: `HYPERDRIVE`, `TENANT_SALT` (per-tenant salt, from DB or env)

**Implementation notes**:
1. Extract from `request.cf` (or request headers): `CF-Connecting-IP` → IP, `CF-IPCountry` → country, `CF-Device-Type` (custom header or parsed).
2. Parse `User-Agent` → summary string (e.g., "Chrome 125 / macOS") — never store raw UA.
3. Extract `Referer` header → strip query params via `new URL(referrer).origin + new URL(referrer).pathname`. Null if absent.
4. Hash IP: `SHA-256(ip + perTenantSalt)` → store hex digest. Null if no `CF-Connecting-IP`.
5. INSERT into `analytics.link_clicks` with all extracted fields.
6. UPDATE `{schemaName}.links SET clicks_count = clicks_count + 1 WHERE short_code = $1`.
7. Wrap entire function in try/catch. On error: `console.error(JSON.stringify({...}))`. Never re-throw.

---

### 4.9 `src/cache/shortcode.ts` — Short Code KV Operations

**Purpose**: KV read/write/invalidate for short_code → original_url mappings with error-boundary fallback.

**Input/Output**:
```typescript
function getCachedUrl(
  env: Env,
  tenantSlug: string,
  shortCode: string
): Promise<string | null>;

function setCachedUrl(
  env: Env,
  tenantSlug: string,
  shortCode: string,
  originalUrl: string
): Promise<void>;

function invalidateCachedUrl(
  env: Env,
  tenantSlug: string,
  shortCode: string
): Promise<void>;
```

**Dependencies**: None (KV binding only)
**Bindings**: `SHORT_URL_CACHE`

**Implementation notes**:
- Key format: `{tenant_slug}:{short_code}`.
- TTL: 86400 seconds (24 hours).
- `getCachedUrl`: Wrap in try/catch — on KV error, return `null` (graceful degradation to DB).
- `setCachedUrl` and `invalidateCachedUrl`: Called via `ctx.waitUntil()`, never awaited inline.
- Never throw from cache operations — log and continue.

---

### 4.10 `src/cache/tenant.ts` — Tenant Schema KV Operations

**Purpose**: KV read/write/invalidate for tenant_slug → schema_name mappings.

**Input/Output**:
```typescript
function getCachedSchema(env: Env, slug: string): Promise<string | null>;
function setCachedSchema(env: Env, slug: string, schemaName: string): Promise<void>;
function invalidateCachedSchema(env: Env, slug: string): Promise<void>;
```

**Dependencies**: None
**Bindings**: `TENANT_CACHE`

**Implementation notes**:
- Key format: `{tenant_slug}` (no prefix needed — separate namespace).
- TTL: 3600 seconds (1 hour).
- Same error-boundary pattern as `cache/shortcode.ts`.
- `getCachedSchema` returns raw value — caller must validate with regex before SQL use.

---

### 4.11 `src/db/client.ts` — Hyperdrive Client Factory

**Purpose**: Create a new `pg.Client` instance per request connected via Hyperdrive connection string.

**Input/Output**:
```typescript
import { Client } from "pg";

function createClient(env: Env): Client {
  return new Client({
    connectionString: env.HYPERDRIVE.connectionString,
  });
}

// Usage pattern (per request):
// const client = createClient(env);
// await client.connect();
// const result = await client.query(...);
// await client.end();  // Returns connection to pool
```

**Dependencies**: `pg` npm package
**Bindings**: `HYPERDRIVE`

**Implementation notes**:
- Hyperdrive manages connection pooling — creating a new `Client` per request is correct.
- Always `await client.end()` after query (returns connection to pool, doesn't close it).
- Consider a query helper that handles connect→query→end lifecycle.
- Do NOT reuse a single `Client` across requests — violates "no module-level request state" rule.

---

### 4.12 `src/db/schema.ts` — Schema Name Validation & Qualified Query Builder

**Purpose**: Validate schema names against KV cache whitelist + regex. Build fully-qualified SQL identifiers.

**Input/Output**:
```typescript
function validateSchemaName(raw: string, kvWhitelist: Set<string>): string;

function qualifiedTable(schema: string, table: string): string;
// Returns: `"tenant_a7f3"."links"` (double-quoted, safe)

function buildQualifiedQuery(
  schema: string,
  template: string
): string;
// Replaces {schema} placeholder with validated, quoted schema name
```

**Dependencies**: None (pure functions)
**Bindings**: None

**Implementation notes**:
- `validateSchemaName`: Check that `raw` exists in KV whitelist (populated from `TENANT_CACHE` or `public.tenants`). Then test regex `^[a-z][a-z0-9_]*$`. Throw if either fails — never fall through to SQL with unvalidated input.
- `qualifiedTable`: Double-quote both schema and table name to handle reserved words. PostgreSQL folds unquoted identifiers to lowercase, but explicit quoting is safer.
- `buildQualifiedQuery`: String replacement with validation check — `SELECT * FROM {schema}.links WHERE short_code = $1`. Never accept raw schema names from user input. The schema name MUST come from the validated KV cache or `public.tenants` query.

---

### 4.13 `src/tenants/provision.ts` — Tenant Schema Creation + DDL

**Purpose**: Execute the full provisioning sequence: create schema, run DDL, track migration version.

**Input/Output**:
```typescript
interface ProvisionResult {
  schemaName: string;  // e.g., 'tenant_a7f3d2b1'
  tenantId: string;
}

async function provisionTenant(
  client: Client,
  tenantId: string,
  schemaName: string
): Promise<void>;
```

**Dependencies**: `db/client.ts`, `db/schema.ts`
**Bindings**: `HYPERDRIVE`

**Implementation notes**:
1. Called from `api/tenants.ts` within an existing transaction.
2. `CREATE SCHEMA "{schemaName}"` (quoted identifier).
3. Execute DDL statements from migration files (embedded as template strings for MVP):
   ```sql
   CREATE TABLE {schema}.links (...);
   CREATE UNIQUE INDEX idx_links_short_code ON {schema}.links(short_code);
   CREATE INDEX idx_links_created_at ON {schema}.links(created_at DESC);
   CREATE INDEX idx_links_active_expires ON {schema}.links(is_active, expires_at) WHERE is_active = true;
   CREATE TABLE {schema}._migrations (...);
   INSERT INTO {schema}._migrations (version, name) VALUES (1, '001_create_links');
   ```
4. Schema name generated from tenant UUID: `tenant_{first 8 chars of UUID}`.
5. Schema name validated before use in `CREATE SCHEMA` call.

---

### 4.14 `src/tenants/deprovision.ts` — Schema Deletion + Cleanup

**Purpose**: Execute clean tenant deletion: DROP SCHEMA CASCADE, delete analytics, delete registry, remove Auth user.

**Input/Output**:
```typescript
async function deprovisionTenant(
  env: Env,
  tenantId: string,
  schemaName: string,
  subdomain: string,
  ownerUserId: string
): Promise<void>;
```

**Dependencies**: `db/client.ts`, `cache/tenant.ts`
**Bindings**: `HYPERDRIVE`, `TENANT_CACHE`, `SUPABASE_SERVICE_ROLE_KEY` (secret)

**Implementation notes**:
1. Called after ownership verification (auth middleware + tenant ownership check).
2. All DB operations in a transaction:
   - `DROP SCHEMA "{schemaName}" CASCADE` — removes links table and all indexes.
   - `DELETE FROM analytics.link_clicks WHERE tenant_id = $1`.
   - `DELETE FROM public.profiles WHERE tenant_id = $1`.
   - `DELETE FROM public.tenants WHERE id = $1`.
3. After DB cleanup: delete Supabase Auth user via Admin API (`fetch` to Supabase with service_role key).
4. Invalidate KV: `ctx.waitUntil(KV.delete(subdomain))`.
5. KV deletion failure is non-fatal — keys expire via TTL independently.
6. Auth user deletion failure is logged but does not roll back DB cleanup (the cascade FK from `public.tenants.owner_id REFERENCES auth.users(id) ON DELETE CASCADE` would require adjusting — or use `SET NULL` for `owner_id` before deleting the auth user).

---

### 4.15 `src/utils/short-code.ts` — nanoid Generation

**Purpose**: Generate URL-safe, collision-resistant short codes.

**Input/Output**:
```typescript
function generateShortCode(): string;
// Returns 7-character string from custom alphabet
```

**Dependencies**: `nanoid` npm package
**Bindings**: None

**Implementation notes**:
```typescript
import { customAlphabet } from "nanoid";

// Removed ambiguous characters: 0, O, I, 1, l
const ALPHABET = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const generateShortCode = customAlphabet(ALPHABET, 7);
// At 7 chars: ~31^7 ≈ 27.5 billion combinations — sufficient for per-tenant uniqueness
```
Per-tenant uniqueness means codes only need to be unique within their schema. Two tenants can independently use `abc123`. Collision probability within a single tenant is ~1 in billions at 7 chars.

---

### 4.16 `src/utils/validation.ts` — Input Validation & Sanitization

**Purpose**: Validate URLs, slugs, and sanitize inputs. Hash IPs.

**Input/Output**:
```typescript
interface UrlValidationResult {
  valid: boolean;
  error?: "invalid_url" | "invalid_protocol" | "blocked_host" | "blocked_ip_range" | "url_too_long";
}

function validateUrl(raw: string): UrlValidationResult;
function validateSlug(raw: string): { valid: boolean; error?: "invalid_slug" | "reserved_slug" | "slug_too_short" | "slug_too_long" };
function hashIp(ip: string, salt: string): Promise<string>;  // SHA-256 hex digest
function sanitizeInput(raw: string, maxLength: number): string;
```

**Dependencies**: `node:crypto` (Web Crypto API)
**Bindings**: None

**Implementation notes**:
- `validateUrl`: Parse with `new URL()`. Check protocol is `http:` or `https:`. Block hostnames: `localhost`, `127.0.0.1`, `0.0.0.0`, `[::1]`. Block private IP ranges (10.x, 172.16-31.x, 192.168.x). Enforce max 2048 chars.
- `validateSlug`: Regex `^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$`. Check against reserved word list (`admin`, `api`, `www`, `static`, `assets`, etc.). Check length 3-30 chars.
- `hashIp`: `await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ip + salt))` → hex string. Uses Web Crypto API (available in Workers). Returns `null` if IP is undefined/null.
- `sanitizeInput`: Trim whitespace. Truncate to `maxLength`. No HTML tag stripping needed (no rendering of user input in MVP).

---

## 5. Data Flow Diagrams

### 5.1 Redirect Request Lifecycle

```
HTTP Request
    │
    ▼
┌─────────────────────┐
│ Extract path params │  /r/{tenant}/{code} → tenant="acme", code="abc123"
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐
│ Resolve tenant slug │  TENANT_CACHE.get("acme") → "tenant_a7f3"
│ (pluggable strategy)│  MISS → DB: public.tenants → KV.put
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐
│ Validate schema     │  Regex + KV whitelist check
│ (injection guard)   │  Reject: 500 (bad schema) / 404 (unknown tenant)
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐
│ Lookup short_code   │  SHORT_URL_CACHE.get("acme:abc123")
│ (KV cache first)    │  HIT  ───────────────────┐
│                     │  MISS ───┐               │
└────────┬────────────┘           │               │
         │                        ▼               │
         │              ┌─────────────────┐       │
         │              │ Hyperdrive query│       │
         │              │ tenant_x.links  │       │
         │              │ → original_url  │       │
         │              │ → is_active     │       │
         │              │ → expires_at    │       │
         │              └────────┬────────┘       │
         │                       │                │
         │              ┌────────▼────────┐       │
         │              │ Evaluate status  │       │
         │              │ !is_active → 410 │       │
         │              │ expired → 410    │       │
         │              │ not found → 404  │       │
         │              │ valid → continue │       │
         │              └────────┬────────┘       │
         │                       │                │
         │              ┌────────▼────────┐       │
         │              │ KV.put (async)  │       │
         │              │ 24h TTL         │       │
         │              └────────┬────────┘       │
         │                       │                │
         └───────────────────────┴────────────────┘
                                 │
                                 ▼
                    ┌────────────────────────┐
                    │ Response.redirect(url, │
                    │                   301) │
                    └────────┬───────────────┘
                             │
                             ▼
                    ┌────────────────────────┐
                    │ ctx.waitUntil(         │
                    │   trackClick(...))     │
                    │ → analytics.link_clicks│
                    │ → clicks_count + 1     │
                    └────────────────────────┘
```

### 5.2 Link Creation Lifecycle

```
POST /api/links + JWT + { original_url }
    │
    ▼
┌───────────────────┐
│ Auth middleware   │  JWT verify → userId, email
│ (JWT validation)  │  Invalid → 401
└────────┬──────────┘
         │
         ▼
┌───────────────────┐
│ Tenant middleware │  Query profiles JOIN tenants → schema_name
│ (schema lookup)   │  No tenant → 404
└────────┬──────────┘
         │
         ▼
┌───────────────────┐
│ URL validation    │  Protocol, localhost, private IP, length
│ (anti-open-redir) │  Invalid → 400
└────────┬──────────┘
         │
         ▼
┌───────────────────┐
│ Count active links│  SELECT COUNT(*) FROM {schema}.links WHERE is_active=true
│ (limit enforcement)│  count >= 30 → 429
└────────┬──────────┘
         │
         ▼
┌───────────────────┐
│ nanoid(7)         │  Custom alphabet, no ambiguous chars
│ (code generation) │
└────────┬──────────┘
         │
         ▼
┌───────────────────────────────────────┐
│ INSERT INTO {schema}.links            │
│ ON CONFLICT (short_code) DO NOTHING  │
│ retry up to 3x if rowCount === 0     │
│ 3x exhausted → 500                   │
└────────┬──────────────────────────────┘
         │
         ▼
┌───────────────────┐
│ KV.put (async)    │  Key: "acme:abc123" → original_url, TTL: 24h
│ (cache warm)      │
└────────┬──────────┘
         │
         ▼
┌───────────────────┐
│ HTTP 201          │  { id, short_code, original_url, short_url, created_at }
│ (response)        │
└───────────────────┘
```

### 5.3 Tenant Lifecycle

```
                  ┌──────────┐
                  │  SIGN-UP │  Supabase Auth (email + password)
                  └────┬─────┘
                       │ JWT returned
                       ▼
              ┌────────────────┐
              │ POST /api/     │
              │   tenants      │
              │ { subdomain,   │
              │   display_name }│
              └───────┬────────┘
                      │
         ┌────────────┼────────────┐
         ▼            ▼            ▼
    Slug validation  DB insert    Schema create
    ───────────────  ─────────    ─────────────
    • regex check    • tenants    • CREATE SCHEMA
    • reserved words • profiles   • DDL (links,
    • uniqueness     (in tx)        indexes,
                      │              _migrations)
                      │              │
                      └──────┬───────┘
                             │
                             ▼
                    ┌────────────────┐
                    │ KV warm        │
                    │ slug→schema    │
                    │ (1h TTL)       │
                    └───────┬────────┘
                            │
                            ▼
                    ┌────────────────┐
                    │ 201 CREATED    │
                    │ { tenant_id,   │
                    │   subdomain,   │
                    │   schema_name }│
                    └────────────────┘

                        ⋮  (tenant is active)

                  ┌──────────┐
                  │  DELETE  │  Admin/owner request
                  └────┬─────┘
                       │
                       ▼
              ┌────────────────┐
              │ Verify ownership│
              │ owner_id check  │
              └───────┬────────┘
                      │
         ┌────────────┼────────────┐
         ▼            ▼            ▼
    DROP SCHEMA   DELETE       DELETE
    CASCADE       analytics    registry
    (all links,   .link_clicks (profiles,
     indexes,     WHERE         tenants)
     _migrations) tenant_id=x   │
         │         │            │
         └─────────┼────────────┘
                   │
         ┌─────────┴──────────┐
         ▼                    ▼
    KV.delete(slug)    DELETE auth.users
    (fails→TTL decay)  (service_role key)
         │                    │
         └────────┬───────────┘
                  │
                  ▼
         ┌────────────────┐
         │ 204 NO CONTENT │
         └────────────────┘
```

### 5.4 Analytics Pipeline

```
Redirect handler sends 301 response
    │
    │  ctx.waitUntil() fires AFTER response
    ▼
┌───────────────────────────┐
│ Extract CF headers        │
│ ───────────────────────── │
│ CF-Connecting-IP → ip     │
│ CF-IPCountry     → country│
│ User-Agent       → summary│  "Chrome 125 / macOS"
│ CF-Device-Type   → device │  (custom header or parsed)
│ Referer          → ref    │  (query params stripped)
└───────────┬───────────────┘
            │
            ▼
┌───────────────────────────┐
│ Hash IP                   │
│ SHA-256(ip + tenant_salt) │
│ → hex digest              │
│ null if IP header missing │
└───────────┬───────────────┘
            │
            ▼
┌───────────────────────────┐
│ INSERT analytics          │
│ .link_clicks              │
│ (tenant_id, link_id,      │
│  ip_hash, summary,        │
│  device, country, ref)    │
└───────────┬───────────────┘
            │
            ▼
┌───────────────────────────┐
│ UPDATE {schema}.links     │
│ SET clicks_count =        │
│   clicks_count + 1        │
│ WHERE short_code = $1     │
└───────────┬───────────────┘
            │
            │  On ANY error:
            ▼
┌───────────────────────────┐
│ catch → structured log    │
│ NEVER propagate           │
│ NEVER affect redirect     │
└───────────────────────────┘
```

---

## 6. Error Handling Strategy

### 6.1 HTTP Status Code Mapping

| Status | Error Code | When |
|--------|-----------|------|
| `400` | `invalid_url`, `invalid_protocol`, `blocked_host`, `blocked_ip_range`, `url_too_long`, `invalid_slug`, `invalid_request` | Client input validation failure |
| `401` | `unauthenticated` | Missing or invalid JWT |
| `403` | `forbidden` | Valid JWT but not tenant owner/admin |
| `404` | `not_found`, `tenant_not_found` | Link code or tenant not found |
| `409` | `subdomain_taken`, `reserved_slug` | Subdomain conflict during provisioning |
| `410` | `link_inactive`, `link_expired` | Link exists but is inactive or expired |
| `429` | `link_limit_reached` | Free tier cap (30 active links) reached |
| `500` | `internal_error`, `link_creation_failed` | Unexpected server error, collision retries exhausted |
| `503` | `service_unavailable` | Database or Hyperdrive unavailable |

### 6.2 Error Response Format

```typescript
interface ErrorResponse {
  error: string;          // Human-readable message
  code: string;           // Machine-readable error code (above)
  details?: unknown;      // Optional additional context (never PII)
}
```

### 6.3 Graceful Degradation

| Failure | Behavior |
|---------|----------|
| **KV unavailable** | Fall through to Hyperdrive DB query. Log warning. Redirect served from DB. |
| **KV + DB unavailable** | Return 503. Log error with structured JSON. No redirect served. |
| **Analytics DB unavailable** | `ctx.waitUntil()` catches error → logs → continues. Redirect still 301. |
| **Empty `CF-Connecting-IP`** | `ip_hash` column stores `NULL`. Tracking proceeds. |
| **KV deletion fails (deprovision)** | Non-fatal. Keys expire via TTL within 1h/24h. Log warning. |
| **Auth user deletion fails** | Log error. DB cleanup already complete. Admin notified manually. |

### 6.4 Error Isolation for `ctx.waitUntil`

Every function passed to `ctx.waitUntil()` MUST wrap its body in try/catch:
```typescript
ctx.waitUntil(
  trackClick(params).catch((e) => {
    console.error(JSON.stringify({
      event: "error",
      type: "analytics_failed",
      message: e instanceof Error ? e.message : String(e),
      code: params.shortCode,
      tenant: params.tenantId,
    }));
    // Swallowed — never affects the redirect
  })
);
```

### 6.5 Supabase Connection Errors

- **No retry in MVP**: If Hyperdrive query fails, return 503. The edge nature of Workers means retries could amplify load.
- **Circuit breaker**: Post-MVP. Track consecutive failures. After N failures, skip DB queries for M seconds (serve only KV hits).
- **Connection timeout**: `pg.Client` with `statement_timeout` set to 3000ms via `options` parameter.

---

## 7. Security Design

### 7.1 Schema Name Injection Prevention

```
User input (tenant slug)
    │
    ▼
┌────────────────────────┐
│ Strategy: extract slug │  Path segment /r/{tenant}/... → "acme"
│ (never raw user input) │  Subdomain {tenant}.domain... → "acme"
└───────────┬────────────┘
            │
            ▼
┌────────────────────────┐
│ TENANT_CACHE.get(slug) │  KV lookup: "acme" → "tenant_a7f3"
│ (KV is populated from  │  KV values come from public.tenants,
│  public.tenants —      │  never from user input
│  trusted source)       │
└───────────┬────────────┘
            │  HIT: "tenant_a7f3"
            │  MISS →
            ▼
┌────────────────────────┐
│ Query public.tenants   │  SELECT schema_name
│ (trusted DB source)    │  FROM public.tenants
│                        │  WHERE subdomain = $1  ← parameterized
│                        │  AND is_active = true
└───────────┬────────────┘
            │  Found: "tenant_a7f3"
            ▼
┌────────────────────────┐
│ Regex validation       │  ^[a-z][a-z0-9_]*$
│ (defense in depth)     │  Only lowercase alphanumeric + underscore
│                        │  Must start with letter
└───────────┬────────────┘
            │  Pass
            ▼
┌────────────────────────┐
│ Use in fully-qualified │  SELECT * FROM "tenant_a7f3"."links"
│ SQL with double-quotes │  WHERE short_code = $1  ← parameterized value
└────────────────────────┘
```

**Why this works**: The schema name can only be one of: (a) a value already in KV cache, populated from `public.tenants`, or (b) a value returned directly from `public.tenants` with a parameterized query. It then passes a strict regex. An attacker cannot inject SQL because schema names come from trusted sources, not user input.

### 7.2 Open Redirect Protection

Validation flow on link creation:

```
original_url input
    │
    ▼
┌────────────────────┐
│ new URL(raw)       │  Parse attempt
│ catch → reject     │  "not-a-url" → 400 invalid_url
└────────┬───────────┘
         │
         ▼
┌────────────────────┐
│ Protocol check     │  Only http: and https:
│ parsed.protocol    │  "ftp://..." → 400 invalid_protocol
│                    │  "javascript:..." → 400 invalid_protocol
└────────┬───────────┘
         │
         ▼
┌────────────────────┐
│ Hostname blocklist │  localhost, 127.0.0.1, 0.0.0.0, [::1]
│                    │  → 400 blocked_host
└────────┬───────────┘
         │
         ▼
┌────────────────────┐
│ Private IP check   │  10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16
│ (resolve hostname  │  → 400 blocked_ip_range
│  if numeric)       │
└────────┬───────────┘
         │
         ▼
┌────────────────────┐
│ Length check       │  Max 2048 characters
│                    │  → 400 url_too_long
└────────┬───────────┘
         │
         ▼
       VALID ✓
```

### 7.3 JWT Validation

1. Extract `Authorization: Bearer <token>` from request header.
2. Verify with `jose.jwtVerify(token, publicKey)` using Supabase JWT secret.
3. Validate claims: `exp` (not expired), `aud` (matches Supabase project).
4. Extract `sub` (user UUID) and `email`.
5. Attach to Hono context: `c.set("user", { userId, email })`.
6. No token → 401. Expired/invalid → 401. Never expose token details in error messages.

### 7.4 Tenant Ownership Verification

On tenant deletion:
1. JWT already validated → `userId` available.
2. Query: `SELECT owner_id FROM public.tenants WHERE id = $1`.
3. Compare: `owner_id === userId` → proceed. No match → 403.
4. Admin override (future): check `public.profiles.role = 'admin'`.

### 7.5 Input Sanitization

| Field | Sanitization |
|-------|-------------|
| `original_url` | Full validation chain (7.2). Stored as-is after validation. |
| `subdomain` (slug) | Regex `^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$`. Reserved word check. |
| `display_name` | Trim whitespace. Max 100 chars. |
| `title` | Trim. Max 200 chars. |
| `short_code` (redirect path) | Extracted from URL path segment by Hono router. Not a raw query parameter. |

### 7.6 Secrets Management

```bash
# Set secrets (NEVER in wrangler.jsonc or source code)
wrangler secret put SUPABASE_URL
wrangler secret put SUPABASE_ANON_KEY
wrangler secret put SUPABASE_SERVICE_ROLE_KEY

# Non-secret env vars (OK in wrangler.jsonc)
{
  "vars": {
    "SHORT_URL_DOMAIN": "acortador.juancode.dev",
    "ENVIRONMENT": "production"
  }
}
```

Access at runtime: `env.SUPABASE_URL`, `env.SUPABASE_SERVICE_ROLE_KEY`. Never log secret values.

---

## 8. Configuration & Bindings

### 8.1 `wrangler.jsonc`

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "link-shortener",
  "main": "src/index.ts",
  "compatibility_date": "2026-06-22",
  "compatibility_flags": ["nodejs_compat"],

  // Observability: structured JSON logs + traces with 5% sampling
  "observability": {
    "enabled": true,
    "logs": {
      "head_sampling_rate": 1
    },
    "traces": {
      "enabled": true,
      "head_sampling_rate": 0.05
    }
  },

  // KV namespaces for caching
  "kv_namespaces": [
    {
      "binding": "SHORT_URL_CACHE",
      "id": "<KV_NAMESPACE_ID_SHORT_URL>",
      "preview_id": "<PREVIEW_ID_SHORT_URL>"
    },
    {
      "binding": "TENANT_CACHE",
      "id": "<KV_NAMESPACE_ID_TENANT>",
      "preview_id": "<PREVIEW_ID_TENANT>"
    }
  ],

  // Hyperdrive: connection pooling to Supabase PostgreSQL
  "hyperdrive": [
    {
      "binding": "HYPERDRIVE",
      "id": "<HYPERDRIVE_CONFIG_ID>",
      "localConnectionString": "postgresql://postgres:postgres@localhost:54322/postgres"
    }
  ],

  // Non-secret environment variables
  "vars": {
    "SHORT_URL_DOMAIN": "acortador.juancode.dev",
    "ENVIRONMENT": "production"
  },

  // Static assets (landing page could optionally use Workers Static Assets)
  // "assets": { "directory": "./public" }
}
```

### 8.2 Secrets (set via `wrangler secret put`)

| Secret | Purpose |
|--------|---------|
| `SUPABASE_URL` | Supabase project URL (`https://<project>.supabase.co`) |
| `SUPABASE_ANON_KEY` | Supabase anonymous key (for JWT validation, public operations) |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key (for Auth user deletion in deprovision) |

### 8.3 TypeScript Types (Generated)

Run `npx wrangler types` after configuring bindings to generate `worker-configuration.d.ts`:
```typescript
// Generated automatically by wrangler types — do not edit manually
interface Env {
  SHORT_URL_CACHE: KVNamespace;
  TENANT_CACHE: KVNamespace;
  HYPERDRIVE: Hyperdrive;
  SHORT_URL_DOMAIN: string;
  ENVIRONMENT: string;
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
}
```

### 8.4 Dependencies (`package.json`)

```json
{
  "dependencies": {
    "hono": "^4.x",
    "pg": "^8.x",
    "nanoid": "^5.x",
    "jose": "^5.x"
  },
  "devDependencies": {
    "@cloudflare/vitest-pool-workers": "^0.x",
    "@cloudflare/workers-types": "^4.x",
    "vitest": "^2.x",
    "wrangler": "^4.x",
    "typescript": "^5.x"
  }
}
```

---

## 9. Testing Strategy

### 9.1 Framework & Configuration

- **Runner**: Vitest with `@cloudflare/vitest-pool-workers` — executes tests inside the Workers runtime with real binding semantics.
- **Config**: `vitest.config.ts` with `pool: "@cloudflare/vitest-pool-workers"`.
- **Integration**: Supabase local development (`supabase start`) for database tests against real PostgreSQL.

### 9.2 Test Matrix

| Module | Unit Tests | Integration Tests | Key Scenarios |
|--------|-----------|-------------------|---------------|
| `utils/validation.ts` | ✅ | — | Valid/invalid URLs, private IPs, localhost block, slug validation, IP hashing |
| `utils/short-code.ts` | ✅ | — | Code length, character set, uniqueness probability |
| `db/schema.ts` | ✅ | — | Schema name validation (valid + SQL injection attempts), qualified query building |
| `cache/shortcode.ts` | ✅ (mock KV) | ✅ (real KV) | Get hit/miss, put with TTL, KV error → null fallback |
| `cache/tenant.ts` | ✅ (mock KV) | ✅ (real KV) | Same as above |
| `middleware/auth.ts` | ✅ (mock JWT) | ✅ (real Supabase Auth) | Valid token, expired, missing, invalid signature |
| `middleware/tenant.ts` | ✅ (mock KV + DB) | ✅ (real DB) | Cache hit/miss, unknown tenant, DB failure |
| `handlers/redirect.ts` | ✅ (mock all deps) | ✅ (real KV + DB) | Cache hit, cache miss, code not found, inactive link, expired link, DB failure → 503 |
| `handlers/landing.ts` | ✅ | — | Returns HTML, contains sign-up/login links |
| `api/links.ts` | ✅ (mock deps) | ✅ (real DB) | Happy path, unauthenticated, invalid URL, limit reached, collision retry |
| `api/tenants.ts` | ✅ (mock deps) | ✅ (real DB) | Provision happy path, duplicate slug, reserved word, schema creation failure rollback, deletion happy path, unauthorized deletion |
| `analytics/tracker.ts` | ✅ (mock DB) | ✅ (real DB) | All headers present, no IP header, referrer query param stripping, DB error → swallow |
| `tenants/provision.ts` | — | ✅ (real DB) | Schema creation, DDL execution, transaction rollback on failure |
| `tenants/deprovision.ts` | — | ✅ (real DB) | DROP SCHEMA CASCADE, analytics cleanup, registry cleanup, KV invalidation |

### 9.3 Test Doubles

```typescript
// Mock KV namespace (in vitest with miniflare)
const mockKV = {
  get: vi.fn().mockResolvedValue(null),
  put: vi.fn().mockResolvedValue(undefined),
  delete: vi.fn().mockResolvedValue(undefined),
};

// Mock Hyperdrive (connection string → mock client)
const mockClient = {
  connect: vi.fn().mockResolvedValue(undefined),
  query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
  end: vi.fn().mockResolvedValue(undefined),
};

// Mock Supabase Auth (JWT verification)
// Use jose with a test JWK to generate valid test tokens
```

### 9.4 Key Test Scenarios Mapped to Spec Requirements

| Spec Requirement | Test Scenario |
|-----------------|---------------|
| REQ-T001 (Slug Validation) | Valid slug, invalid chars, reserved word, duplicate |
| REQ-T002 (Provisioning) | Happy path, schema creation failure → rollback, auth failure |
| REQ-T003 (Deletion) | Full deletion, tenant not found, unauthorized, KV down during deletion |
| REQ-L001 (Link Creation) | Happy path, missing auth, invalid URL, collision retry, schema not resolved |
| REQ-L002 (Limit) | Under limit, at limit, inactive links excluded |
| REQ-L003 (Lifecycle) | Active redirects, inactive → 410, expired → 410, future expiry OK |
| REQ-R001 (Redirect) | Full cache hit, KV miss + DB hit, code not found, DB failure → 503 |
| REQ-R002 (Pluggable) | Path-based extraction, KV lookup resolves, KV miss → DB, unknown tenant |
| REQ-A001 (Tracking) | Successful tracking, analytics failure doesn't block redirect, referrer stripping |
| REQ-A002 (IP Hashing) | IP hashed before storage, missing IP → NULL |
| REQ-S001 (Open Redirect) | Valid HTTPS, blocked protocol, localhost blocked, private IP blocked, oversized URL |
| REQ-S002 (Abuse) | Collision retry succeeds, retries exhausted, active link count correct |
| REQ-O001 (Logging) | Cache hit log format, error log format, no PII in logs |
| REQ-O002 (Degradation) | Analytics swallows errors, KV unavailable → DB fallback, DB unavailable → 503 |
| REQ-LP001 (Landing) | Root path serves HTML, mobile responsive, no external deps |

### 9.5 CI/CD Integration

```bash
# Type check
npx tsc --noEmit

# Unit + integration tests (Vitest with Workers pool)
npx vitest run

# Deploy (after tests pass)
npx wrangler deploy
```

---

## Architecture Decisions

| Decision | Choice | Rationale | Trade-off |
|----------|--------|-----------|-----------|
| Compute model | Single Worker, Hono router | Simplest deployment, single codebase. Clean module boundaries prevent coupling. | No independent scaling of redirect vs API |
| Tenant isolation | Schema-per-tenant | Structural isolation, instant DROP CASCADE deletion, no RLS complexity | Migration complexity × N schemas |
| Tenant routing (MVP) | Path-based `/r/{tenant}/{code}` | Zero DNS config for initial deploy, trivial Worker URL parsing | Cleaner URLs with subdomain (future) |
| Pluggable resolution | Strategy interface | Swap path-based for subdomain-based without touching handlers | Slight abstraction overhead |
| Cache strategy | KV write-aside, 24h/1h TTL | Simple, free tier sufficient, TTL handles stale data | Eventual consistency (KV ~60s propagation) |
| Cache key format | `{tenant_slug}:{short_code}` | Separate KV namespace, colon delimiter, prefix-based listing if needed | Longer keys |
| Connection pooling | Hyperdrive | 300-500ms savings per cache miss, regional pools, query caching | Additional Cloudflare cost |
| SQL approach | Fully-qualified (`schema.table`) | No `SET search_path`, no connection pool fragmentation, no state leakage | Verbose queries |
| Schema validation | KV whitelist + regex | Defense-in-depth against SQL injection. Never raw user input. | Two validation steps per query |
| Short code generation | nanoid 7 chars, custom alphabet, per-tenant unique | URL-safe, no DB round-trip, ~27B combinations per tenant | Not human-readable, not sequential |
| Analytics path | `ctx.waitUntil()` (fire-and-forget) | Zero impact on redirect latency | No retry on failure in MVP |
| IP storage | SHA-256 + per-tenant salt | GDPR-compliant from day one, irreversible | Cannot reconstruct original IP |
| Error isolation | `ctx.waitUntil` wraps in try/catch | Analytics failure never blocks redirect | Failed clicks are lost (acceptable for MVP) |
| KV deletion failure | Non-fatal during deprovision | TTL ensures eventual cleanup. Simpler than distributed cleanup coordination. | Cached data survives up to 24h after deletion |

---

## Open Questions

- [ ] **Rate limiting implementation**: Cloudflare WAF rules vs Worker-level token bucket. Decision deferred to post-MVP but should be prioritized before public launch.
- [ ] **Per-tenant salt storage**: Where to store the salt used for IP hashing? Options: `public.tenants` column, KV, or derived from `tenant.id + secret`. Recommend `public.tenants` column for simplicity.
- [ ] **Landing page design specifics**: Deferred to implementation. Content includes service name, description, and Supabase Auth sign-up/login links.
- [ ] **Monetization model**: Free tier (30 links) defined. Paid tier limits and features TBD. Architecture supports adding limits without schema changes.
- [ ] **Custom domain support**: Not in MVP scope. Architecture supports adding via additional `public.tenants` column + DNS verification flow.
