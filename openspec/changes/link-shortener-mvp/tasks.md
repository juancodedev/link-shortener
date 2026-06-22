# Tasks: Link Shortener MVP

## Review Workload Forecast

| Phase | Tasks | Estimated Lines | Cumulative |
|-------|-------|----------------|------------|
| 1: Foundation | 5 | ±305 | ±305 |
| 2: Core Infrastructure | 7 | ±245 | ±550 |
| 3: Middleware | 3 | ±160 | ±710 |
| 4: API Endpoints | 4 | ±355 | ±1065 |
| 5: Handlers | 3 | ±180 | ±1245 |
| 6: Router & Integration | 2 | ±85 | ±1330 |
| 7: Testing | 5 | ±600 | ±1930 |
| 8: Landing Page Content | 1 | ±80 | ±2010 |
| **Total** | **30** | **±2010** | |

Decision needed before apply: Yes
Chained PRs recommended: Yes
Chain strategy: pending
400-line budget risk: HIGH

### Suggested Work Units for Chained PRs

| Unit | Goal | Est. Lines | Scope |
|------|------|------------|-------|
| PR1: Foundation + Infra | Config, migrations, DB client, utils, cache | ±550 | Phase 1 + 2 |
| PR2: Middleware + Handlers | Auth, tenant, error middleware; redirect, landing, analytics | ±340 | Phase 3 + 5 |
| PR3: API + Router | Link creation, tenant CRUD, provision, deprovision, router, worker entry, landing HTML | ±520 | Phase 4 + 6 + 8 |
| PR4: Testing | Unit + integration tests covering all 15 spec requirements | ±600 | Phase 7 |

---

## Phase 1: Foundation

### [x] Task 1.1: Project scaffold and tooling config
**Priority**: P0
**Depends on**: none
**Estimated lines**: ±55
**Files**: `package.json`, `tsconfig.json`
**Description**: Init npm project with dependencies (hono, pg, nanoid, jose). Add devDependencies (wrangler, vitest, @cloudflare/vitest-pool-workers, @cloudflare/workers-types, typescript). Configure tsconfig with `node` module resolution targeting ES2022.
**Verification**: `npm install` succeeds. `npx tsc --noEmit` reports no errors on empty project.
**Spec coverage**: Infrastructure prerequisite for all REQs.

### [x] Task 1.2: Wrangler and Vitest configuration
**Priority**: P0
**Depends on**: 1.1
**Estimated lines**: ±80
**Files**: `wrangler.jsonc`, `vitest.config.ts`
**Description**: Create `wrangler.jsonc` with two KV namespaces (`SHORT_URL_CACHE`, `TENANT_CACHE`), Hyperdrive binding (`HYPERDRIVE`), vars (`SHORT_URL_DOMAIN`, `ENVIRONMENT`), observability config, and `nodejs_compat` flag. Create `vitest.config.ts` with `@cloudflare/vitest-pool-workers` pool. Do NOT set KV/Hyperdrive IDs (placeholders).
**Verification**: `npx wrangler types` generates `worker-configuration.d.ts`. `npx vitest run` executes without test files (passes empty suite).
**Spec coverage**: REQ-O001 (observability config for structured logging).

### [x] Task 1.3: Environment type definitions
**Priority**: P0
**Depends on**: 1.2
**Estimated lines**: ±45
**Files**: `worker-configuration.d.ts` (generated), `src/types/env.ts`
**Description**: Generate types via `npx wrangler types`. Create supplemental types file with `SupabaseSecrets` interface (url, anonKey, serviceRoleKey), `AuthenticatedUser` interface, and `TenantContext` interface. Export `Env` extending generated bindings + secrets + vars.
**Verification**: TypeScript compiles. All binding names match `wrangler.jsonc` entries.
**Spec coverage**: Type foundation for all authenticated and tenant-aware flows.

### [x] Task 1.4: Supabase public schema migration
**Priority**: P0
**Depends on**: none
**Estimated lines**: ±50
**Files**: `supabase/migrations/00001_public_schema.sql`
**Description**: Create migration for `public.tenants` table (id UUID PK, schema_name UNIQUE, display_name, subdomain UNIQUE, owner_id FK→auth.users, is_active, created_at), `public.profiles` table (id FK→auth.users PK, tenant_id FK→public.tenants, role, created_at), and partial indexes (`idx_tenants_subdomain WHERE is_active=true`, `idx_tenants_owner`, `idx_profiles_tenant`). Include `public._migrations` tracking table.
**Verification**: SQL parses without errors. `supabase db reset` applies migration locally.
**Spec coverage**: REQ-T001 (subdomain uniqueness constraint), REQ-T002 (tenants + profiles tables).

### [x] Task 1.5: Supabase analytics + per-tenant template migrations
**Priority**: P0
**Depends on**: 1.4
**Estimated lines**: ±75
**Files**: `supabase/migrations/00002_analytics_schema.sql`, `supabase/migrations/tenant/001_create_links.sql`
**Description**: Migration 00002: create `analytics` schema with `link_clicks` table (tenant_id FK→public.tenants, link_id UUID no FK, ip_hash, user_agent_summary, device_type, country_code, referrer, created_at) plus indexes and `_migrations` table. Tenant template: create `links` table (id UUID PK, original_url, short_code UNIQUE, title, clicks_count, is_active, expires_at, created_at, updated_at) plus indexes and `_migrations` table.
**Verification**: SQL parses without errors. Template DDL is idempotent (uses `IF NOT EXISTS` where applicable).
**Spec coverage**: REQ-A001 (link_clicks schema), REQ-L003 (is_active + expires_at columns).

---

## Phase 2: Core Infrastructure

### [x] Task 2.1: Hyperdrive client factory
**Priority**: P0
**Depends on**: 1.3
**Estimated lines**: ±25
**Files**: `src/db/client.ts`
**Description**: Export `createClient(env: Env)` returning `new Client({ connectionString: env.HYPERDRIVE.connectionString })`. Export `withClient<T>(env, fn)` helper that creates client, connects, executes `fn(client)`, calls `client.end()`, and returns result. Uses `pg` npm package.
**Verification**: TypeScript compiles. Helper pattern correctly types generic `fn`.
**Spec coverage**: Dependency for all database-using components.

### [x] Task 2.2: Schema name validation and qualified query builder
**Priority**: P0
**Depends on**: 1.3
**Estimated lines**: ±50
**Files**: `src/db/schema.ts`
**Description**: Export `validateSchemaName(raw: string): string` — regex `^[a-z][a-z0-9_]*$`, throw on failure. Export `qualifyTable(schema: string, table: string): string` — returns double-quoted `"schema"."table"`. Export `buildQuery(schema: string, template: string): string` — replaces `{schema}` placeholder with validated, double-quoted schema name, throws if validation fails.
**Verification**: Unit test verifies regex blocks SQL injection strings (e.g., `'; DROP TABLE--`). `qualifyTable('tenant_a7f3', 'links')` returns `"tenant_a7f3"."links"`.
**Spec coverage**: REQ-R002 (schema name validation defense-in-depth).

### [x] Task 2.3: Short code generator
**Priority**: P0
**Depends on**: 1.1
**Estimated lines**: ±15
**Files**: `src/utils/short-code.ts`
**Description**: Export `generateShortCode()` using `nanoid`'s `customAlphabet` with a 54-char alphabet (no ambiguous chars: 0/O/I/1/l removed). Length: 7 characters. Returns URL-safe string.
**Verification**: Generated code is 7 chars. Contains only characters from the defined alphabet. Two consecutive calls produce different values.
**Spec coverage**: REQ-L001 (short code generation), REQ-S002 (collision resistance).

### [x] Task 2.4: URL validation and input sanitization
**Priority**: P0
**Depends on**: 1.3
**Estimated lines**: ±75
**Files**: `src/utils/validation.ts`
**Description**: Export `validateUrl(raw: string): { valid: boolean; error?: string }` — parses with `new URL()`, checks protocol (http/https only), blocks localhost/127.0.0.1/0.0.0.0/[::1], blocks private IPs (10.x, 172.16-31.x, 192.168.x), enforces max 2048 chars. Export `validateSlug(raw: string): { valid: boolean; error?: string }` — regex `^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$`, 3-30 chars, reserved word check. Export `sanitizeInput(raw: string, maxLen: number): string` — trim whitespace, truncate.
**Verification**: `validateUrl('ftp://x')` → invalid_protocol. `validateUrl('http://localhost:3000')` → blocked_host. `validateUrl('http://192.168.1.1')` → blocked_ip_range. `validateSlug('admin')` → reserved_slug.
**Spec coverage**: REQ-S001 (URL validation), REQ-T001 (slug validation).

### [x] Task 2.5: IP hashing utility
**Priority**: P0
**Depends on**: 1.3
**Estimated lines**: ±20
**Files**: `src/utils/ip-hash.ts`
**Description**: Export `hashIp(ip: string | null, salt: string): Promise<string | null>` — uses Web Crypto API `crypto.subtle.digest('SHA-256', ...)` to hash `ip + salt`. Returns hex digest or `null` if ip is null/undefined.
**Verification**: `hashIp('1.2.3.4', 'salt123')` returns 64-char hex string. `hashIp(null, 'salt')` returns `null`. Same input + salt produces deterministic output.
**Spec coverage**: REQ-A002 (IP hashing before storage).

### [x] Task 2.6: Short code KV cache module
**Priority**: P0
**Depends on**: 1.3
**Estimated lines**: ±30
**Files**: `src/cache/shortcode.ts`
**Description**: Export `getCachedUrl(env, tenantSlug, shortCode)` → `Promise<string|null>` wrapped in try/catch (KV error → null). Export `setCachedUrl(env, tenantSlug, shortCode, url)` → `Promise<void>` with `expirationTtl: 86400`. Export `invalidateCachedUrl(env, tenantSlug, shortCode)` → `Promise<void>`. Key format: `{tenantSlug}:{shortCode}`. All functions use `SHORT_URL_CACHE` binding. Never throw — log and return null.
**Verification**: Mock KV namespace in unit test. `getCachedUrl` on KV error returns null (graceful degradation). `setCachedUrl` writes with correct TTL.
**Spec coverage**: REQ-R001 (short URL KV cache), REQ-O002 (KV unavailable → fallback).

### [x] Task 2.7: Tenant schema KV cache module
**Priority**: P0
**Depends on**: 1.3
**Estimated lines**: ±30
**Files**: `src/cache/tenant.ts`
**Description**: Export `getCachedSchema(env, slug)` → `Promise<string|null>`. Export `setCachedSchema(env, slug, schemaName)` → `Promise<void>` with TTL 3600. Export `invalidateCachedSchema(env, slug)` → `Promise<void>`. Key: tenant slug only (separate namespace). Same error-boundary pattern as shortcode cache. Caller must validate returned schema name with regex before SQL use.
**Verification**: Mock KV. `getCachedSchema` on error returns null. `setCachedSchema` with TTL 3600.
**Spec coverage**: REQ-R002 (tenant schema cache), REQ-T002 (KV warm on provisioning), REQ-T003 (KV invalidation on deletion).

---

## Phase 3: Middleware

### [x] Task 3.1: JWT auth middleware
**Priority**: P0
**Depends on**: 1.3, 2.4
**Estimated lines**: ±55
**Files**: `src/middleware/auth.ts`
**Description**: Hono middleware extracting `Authorization: Bearer <token>`, verifying with `jose.jwtVerify()` against Supabase JWT secret, validating `exp` and `aud`. Sets `c.set('user', { userId: payload.sub, email: payload.email })` on success. Returns 401 `{ error: 'unauthenticated' }` on failure. Skip for unauthenticated routes via guard pattern.
**Verification**: Mock valid/invalid/expired tokens. Valid token sets context. Invalid returns 401 with correct error code. Missing header returns 401.
**Spec coverage**: REQ-L001 (authenticated link creation — 401 scenario), REQ-T002 (auth failure → 401).

### [x] Task 3.2: Tenant resolution middleware
**Priority**: P0
**Depends on**: 2.2, 2.6, 2.7, 3.1
**Estimated lines**: ±70
**Files**: `src/middleware/tenant.ts`
**Description**: Define `TenantResolutionStrategy` interface with `extractTenantSlug(c): string`. Implement `PathBasedStrategy` extracting from `c.req.param('tenant')`. Middleware: extract slug → check `TENANT_CACHE` (validate cached value with regex) → on miss query `public.tenants WHERE subdomain=$1 AND is_active=true` via Hyperdrive → cache result → set context. Not found → 404. Set `c.set('tenant', { tenantSlug, schemaName })`. Schema name validated with `validateSchemaName()` before use.
**Verification**: Mock KV hit returns cached schema. KV miss queries DB and populates KV. Unknown tenant returns 404. SQL injection via slug blocked by regex + parameterized query.
**Spec coverage**: REQ-R002 (pluggable tenant extraction, KV lookup, DB fallback, unknown tenant), REQ-T002 (schema resolution).

### [x] Task 3.3: Error handler middleware
**Priority**: P0
**Depends on**: 1.3
**Estimated lines**: ±35
**Files**: `src/middleware/error.ts`
**Description**: Hono error-handling middleware wrapping all routes in try/catch. Catches thrown errors, logs structured JSON (`{ event: 'error', type, message, code?, tenant? }`), and returns appropriate HTTP status with `{ error, code }` body. Maps known error types to status codes (400, 401, 403, 404, 409, 410, 429). Unknown errors → 500. Never exposes stack traces in production.
**Verification**: Throw a known error → correct status + body. Throw unknown error → 500 without stack. Structured log output contains no PII.
**Spec coverage**: REQ-O001 (structured error logging), REQ-O002 (graceful degradation — errors don't crash Worker).

---

## Phase 4: API Endpoints

### Task 4.1: Link creation endpoint
**Priority**: P0
**Depends on**: 2.1, 2.2, 2.3, 2.4, 2.6, 3.1, 3.2
**Estimated lines**: ±110
**Files**: `src/api/links.ts`
**Description**: Handle `POST /api/links`. JWT user from context (auth middleware). Tenant schema from context (tenant middleware). Validate `original_url` via `validateUrl()`. Count active links: `SELECT COUNT(*) FROM {schema}.links WHERE is_active=true`. Reject if ≥30 → 429. Generate short code via `generateShortCode()`. Insert with `ON CONFLICT (short_code) DO NOTHING` — if rowCount 0, retry up to 3x. On success, `ctx.waitUntil(setCachedUrl(...))`. Return 201 with link resource + `short_url` constructed from `SHORT_URL_DOMAIN`.
**Verification**: Happy path → 201. Invalid URL → 400. At limit → 429. Collision retry succeeds. All 3 retries fail → 500. No auth → 401. No tenant → 404.
**Spec coverage**: REQ-L001 (all 5 scenarios), REQ-L002 (all 3 scenarios), REQ-S001 (URL validation on creation), REQ-S002 (collision retry, limit enforcement).

### Task 4.2: Tenant management endpoint
**Priority**: P0
**Depends on**: 2.1, 2.4, 3.1, 3.2
**Estimated lines**: ±95
**Files**: `src/api/tenants.ts`
**Description**: Handle `POST /api/tenants` (provision) and `DELETE /api/tenants/:id` (deprovision). POST: validate slug via `validateSlug()`, check uniqueness against `public.tenants WHERE subdomain=$1`, delegate to `provisionTenant()`. Return 201 with tenant resource or 409 if duplicate. DELETE: verify JWT userId matches tenant owner_id (query `public.tenants WHERE id=$1`), delegate to `deprovisionTenant()`. Return 204 on success, 403 if not owner, 404 if not found.
**Verification**: POST happy path → 201. Duplicate slug → 409. Invalid slug → 400. DELETE happy path → 204. Not owner → 403. Not found → 404.
**Spec coverage**: REQ-T001 (slug validation, reserved words, duplicate), REQ-T002 (provisioning entry point), REQ-T003 (all 4 deletion scenarios).

### Task 4.3: Tenant provisioning logic
**Priority**: P0
**Depends on**: 2.1, 2.2
**Estimated lines**: ±80
**Files**: `src/tenants/provision.ts`
**Description**: Export `provisionTenant(client, userId, subdomain, displayName)` → `{ schemaName, tenantId }`. In a transaction: INSERT into `public.tenants` (generating `schema_name` as `tenant_{first8ofUUID}`), INSERT into `public.profiles` (role='owner'), CREATE SCHEMA via `buildQuery(schema, 'CREATE SCHEMA {schema}')`, execute DDL from tenant template migration (CREATE TABLE links + indexes + _migrations). On any failure: ROLLBACK transaction and throw.
**Verification**: Integration test with real DB. Successful provisioning creates schema with links table. Schema creation failure rolls back tenant + profile inserts. Generated schema name follows `tenant_XXXXXXXX` pattern.
**Spec coverage**: REQ-T002 (successful provisioning, schema creation failure → rollback).

### Task 4.4: Tenant deprovisioning logic
**Priority**: P0
**Depends on**: 2.1, 2.2, 2.5, 2.7
**Estimated lines**: ±70
**Files**: `src/tenants/deprovision.ts`
**Description**: Export `deprovisionTenant(env, tenantId, schemaName, subdomain, ownerUserId)`. In a transaction: DROP SCHEMA `{schemaName}` CASCADE, DELETE FROM `analytics.link_clicks WHERE tenant_id=$1`, DELETE FROM `public.profiles WHERE tenant_id=$1`, DELETE FROM `public.tenants WHERE id=$1`. After DB commit: DELETE auth user via Supabase Admin API (`fetch` with service_role key), invalidate KV: `ctx.waitUntil(invalidateCachedSchema(...))`. KV and Auth failures are non-fatal (logged, not thrown).
**Verification**: Integration test verifies schema gone, analytics cleaned, registry empty, KV key deleted. KV failure during deletion → DB cleanup succeeds, error logged. Auth API failure → logged, DB cleanup not rolled back.
**Spec coverage**: REQ-T003 (full deletion, KV unavailable → non-fatal).

---

## Phase 5: Handlers

### [x] Task 5.1: Redirect handler
**Priority**: P0
**Depends on**: 2.1, 2.2, 2.6, 2.7, 3.2, 3.3
**Estimated lines**: ±80
**Files**: `src/handlers/redirect.ts`
**Description**: Handle `GET /r/:tenant/:code`. Extract tenant slug and code from params. Resolve schema via tenant middleware (or inline if middleware not applicable). Generate KV key: `{slug}:{code}`. KV hit → evaluate `is_active`/`expires_at` (if stored in KV, or must query DB for status) → return 301/410. KV miss → query `{schema}.links WHERE short_code=$1` → evaluate status → if active, `ctx.waitUntil(setCachedUrl(...))` + return 301. Always `ctx.waitUntil(trackClick(...))` after 301. Never destructure ctx.
**Verification**: KV hit → 301 + click tracked. KV miss + DB hit → 301 + KV populated. Code not found → 404. Inactive link → 410. Expired link → 410. DB failure → 503.
**Spec coverage**: REQ-R001 (all 4 scenarios), REQ-L003 (activation + expiration — all 4 scenarios), REQ-O002 (degradation scenarios).

### [x] Task 5.2: Landing page handler
**Priority**: P0
**Depends on**: 1.3
**Estimated lines**: ±30
**Files**: `src/handlers/landing.ts`
**Description**: Handle `GET /`. Return inline HTML string with `Content-Type: text/html`. HTML includes service name ("Link Shortener"), brief description, and links to Supabase Auth sign-up/login (URLs constructed from `env.SUPABASE_URL`). Include `<meta name="viewport">` for responsiveness. Detailed HTML content deferred to Phase 8; this task provides the handler skeleton with minimal HTML.
**Verification**: GET / returns 200 with text/html. Response body contains service name and Supabase Auth links. No external scripts or dependencies.
**Spec coverage**: REQ-LP001 (root path serves landing page — handler shell).

### [x] Task 5.3: Click analytics tracker
**Priority**: P0
**Depends on**: 2.1, 2.2, 2.5
**Estimated lines**: ±70
**Files**: `src/analytics/tracker.ts`
**Description**: Export `trackClick(env, { tenantId, schemaName, linkId, shortCode, request })` → `Promise<void>`. Extract: `CF-Connecting-IP` → IP, `CF-IPCountry` → country, `CF-Device-Type` → device_type, User-Agent → summary (e.g., "Chrome 125 / macOS" using basic UA parsing), Referer → strip query params via `new URL(ref).origin + pathname`. Hash IP via `hashIp(ip, tenantSalt)`. INSERT into `analytics.link_clicks`. UPDATE `{schemaName}.links SET clicks_count = clicks_count + 1 WHERE short_code=$1`. Entire function wrapped in try/catch — errors logged as JSON, never re-thrown. Called via `ctx.waitUntil()` only.
**Verification**: All headers present → row inserted + clicks_count incremented. Missing IP → ip_hash NULL. Referrer with query params → params stripped. DB error → error logged, no exception propagated.
**Spec coverage**: REQ-A001 (all 3 scenarios), REQ-A002 (IP hashed, missing IP → NULL).

---

## Phase 6: Router & Integration

### Task 6.1: Hono route definitions
**Priority**: P0
**Depends on**: 3.3, 4.1, 4.2, 5.1, 5.2
**Estimated lines**: ±45
**Files**: `src/router.ts`
**Description**: Create Hono app instance. Register routes: `GET /` → errorHandler → landing, `GET /r/:tenant/:code` → errorHandler → redirect, `POST /api/links` → errorHandler → auth → tenant(api) → createLink, `POST /api/tenants` → errorHandler → auth → provisionTenant, `DELETE /api/tenants/:id` → errorHandler → auth → deprovisionTenant. Export `createApp(env)` factory.
**Verification**: Hono router compiles without type errors. All route handlers receive correct context types. Middleware chains match design route table.
**Spec coverage**: Integration point for all endpoint REQs.

### Task 6.2: Worker entry point and integration
**Priority**: P0
**Depends on**: 1.2, 1.3, 6.1
**Estimated lines**: ±85
**Files**: `src/index.ts`
**Description**: Export default fetch handler. Instantiate Hono app via `createApp(env)`. Call `app.fetch(request, env, ctx)`. Wire `env` bindings to all dependencies. Set up global error boundary for uncaught exceptions. Enable structured JSON logging for all requests via `console.log(JSON.stringify({...}))`. Landing page HTML fully inlined here or in handler.
**Verification**: `npx wrangler dev` starts local server. All routes respond correctly. `wrangler deploy` succeeds (to dev environment).
**Spec coverage**: REQ-O001 (structured logging on every request), REQ-LP001 (landing page serves at root).

---

## Phase 7: Testing

### Task 7.1: Unit tests for utilities
**Priority**: P0
**Depends on**: 2.3, 2.4, 2.5
**Estimated lines**: ±120
**Files**: `test/utils/short-code.test.ts`, `test/utils/validation.test.ts`, `test/utils/ip-hash.test.ts`
**Description**: Test `generateShortCode()` for length, alphabet, uniqueness. Test `validateUrl()` for all valid + all 5 invalid scenarios (invalid_protocol, blocked_host, blocked_ip_range, url_too_long, invalid_url). Test `validateSlug()` for valid + reserved + invalid chars + too short + too long. Test `sanitizeInput()` for trimming + truncation. Test `hashIp()` for deterministic output, null handling. Mocks: none (pure functions + Web Crypto).
**Verification**: All 53 spec scenarios for REQ-S001, REQ-T001, REQ-A002 pass. `npx vitest run test/utils/` passes.
**Spec coverage**: REQ-S001, REQ-T001, REQ-A002, REQ-S002 (collision scenarios).

### Task 7.2: Unit tests for cache and DB modules
**Priority**: P0
**Depends on**: 2.1, 2.2, 2.6, 2.7
**Estimated lines**: ±100
**Files**: `test/db/schema.test.ts`, `test/cache/shortcode.test.ts`, `test/cache/tenant.test.ts`
**Description**: Test `validateSchemaName()` with valid names + SQL injection strings. Test `qualifyTable()` and `buildQuery()` for correct quoting + placeholder replacement. Test cache modules with mocked KV (vitest `vi.fn()`): get on hit/miss/error, set with correct key + TTL, invalidate. Test `getCachedUrl()` returns null on KV error (graceful degradation).
**Verification**: Mocked KV calls return expected values. SQL injection via schema name blocked by regex. `npx vitest run test/db/ test/cache/` passes.
**Spec coverage**: REQ-R002 (schema validation), REQ-O002 (KV error fallback).

### Task 7.3: Unit tests for middleware
**Priority**: P0
**Depends on**: 3.1, 3.2, 3.3
**Estimated lines**: ±120
**Files**: `test/middleware/auth.test.ts`, `test/middleware/tenant.test.ts`, `test/middleware/error.test.ts`
**Description**: Mock JWT: test valid token sets context, expired/invalid/missing returns 401. Mock KV + DB for tenant middleware: cache hit uses cached schema, cache miss queries DB and populates cache, unknown tenant → 404. Test error middleware: known error codes map to correct status, unknown errors → 500, no stack traces in response.
**Verification**: Auth: 3 scenarios pass. Tenant: 4 scenarios pass (hit, miss→DB, unknown, injection attempt). Error: code mapping + no PII in logs.
**Spec coverage**: REQ-T002 (auth failure), REQ-R002 (tenant resolution scenarios), REQ-O001 (no PII in error logs).

### Task 7.4: Integration tests for API endpoints and handlers
**Priority**: P0
**Depends on**: 4.1, 4.2, 5.1, 5.3, 7.1
**Estimated lines**: ±180
**Files**: `test/api/links.test.ts`, `test/api/tenants.test.ts`, `test/handlers/redirect.test.ts`, `test/analytics/tracker.test.ts`
**Description**: Integration tests with mocked KV + Hyperdrive (mock pg Client). Links API: happy path, unauthenticated, invalid URL format, limit reached, collision retry (success + exhaustion), schema not resolved. Tenants API: provision happy path, duplicate slug, delete happy path, unauthorized deletion, tenant not found. Redirect: cache hit → 301, cache miss → DB → 301 + KV populate, code not found → 404, inactive → 410, expired → 410, DB failure → 503. Tracker: successful insert + update, missing IP header → NULL, DB error swallowed.
**Verification**: Each handler/API returns correct status code + body per spec scenarios. `npx vitest run test/api/ test/handlers/ test/analytics/` passes.
**Spec coverage**: REQ-L001, REQ-L002, REQ-L003, REQ-R001, REQ-A001, REQ-S002.

### Task 7.5: Integration tests for tenant lifecycle and landing page
**Priority**: P0
**Depends on**: 4.3, 4.4, 5.2
**Estimated lines**: ±80
**Files**: `test/tenants/provision.test.ts`, `test/tenants/deprovision.test.ts`, `test/handlers/landing.test.ts`
**Description**: Provision: schema creation + DDL execution verified, transaction rollback on failure, KV warm after commit. Deprovision: DROP SCHEMA CASCADE verified, analytics cleanup, registry cleanup, KV invalidation, KV failure → non-fatal. Landing: GET / returns 200 + text/html, body contains service name + signup/login links, no `<script>` tags, no external CSS.
**Verification**: Provision creates expected DB objects. Deprovision leaves no trace. Landing page meets LP001 requirements.
**Spec coverage**: REQ-T002 (provisioning scenarios), REQ-T003 (all deletion scenarios), REQ-LP001 (all 3 scenarios).

---

## Phase 8: Landing Page Content

### Task 8.1: Landing page HTML design
**Priority**: P1
**Depends on**: 5.2
**Estimated lines**: ±80
**Files**: `src/handlers/landing.ts` (HTML content)
**Description**: Complete the landing page HTML with service name ("Link Shortener" / "Acortador"), tagline ("Short links with analytics — simple, fast, multi-tenant"), sign-up button linking to Supabase Auth signup URL, login link to Supabase Auth login URL, and a brief how-it-works section. Responsive CSS via `<meta name="viewport">` + media queries (stack vertically on mobile ≤ 768px). No frameworks, no `<script>`, no external CSS. Mobile breakpoint: content reflows, no horizontal scroll at 375px.
**Verification**: Browser renders at 375px and 1024px without overflow. Lighthouse audit passes accessibility + best practices. No external resource requests in network tab.
**Spec coverage**: REQ-LP001 (all 3 scenarios).
