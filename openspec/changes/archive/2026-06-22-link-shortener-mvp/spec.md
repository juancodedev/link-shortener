# Spec: Link Shortener MVP

## ADDED: Tenant Provisioning
**Status**: proposed
**Priority**: P0

### Requirements

#### REQ-T001: Subdomain Slug Validation
**Priority**: P0
The system MUST validate tenant subdomain slugs before provisioning. Slugs MUST be 3–30 characters, alphanumeric plus hyphens, not match reserved words, and not duplicate an existing tenant.

##### Scenario: Valid slug accepted
- **GIVEN** a user provides subdomain slug "acme-corp"
- **WHEN** the system validates the slug
- **THEN** validation passes and provisioning may proceed

##### Scenario: Invalid characters
- **GIVEN** a user provides slug "acme corp!" with spaces and symbols
- **WHEN** the system validates the slug
- **THEN** the system rejects with error code "invalid_slug"

##### Scenario: Reserved word
- **GIVEN** a user provides slug "admin"
- **WHEN** the system validates the slug against the reserved-word list
- **THEN** the system rejects with error code "reserved_slug"

##### Scenario: Duplicate subdomain
- **GIVEN** tenant "acme" already exists in `public.tenants`
- **WHEN** another user attempts to claim "acme"
- **THEN** the system rejects with error code "subdomain_taken" and HTTP 409

#### REQ-T002: Tenant and Schema Provisioning
**Priority**: P0
The system MUST create a tenant record, a profile, a dedicated PostgreSQL schema with the `links` table, and warm the KV cache with the slug-to-schema mapping as a single atomic provisioning operation triggered on sign-up.

##### Scenario: Successful provisioning
- **GIVEN** a user completes Supabase Auth sign-up with a valid, unique slug
- **WHEN** provisioning executes
- **THEN** a row is inserted in `public.tenants`, a row in `public.profiles`, a schema `tenant_{id}` is created with a `links` table, and KV stores `slug → schema_name`

##### Scenario: Schema creation failure
- **GIVEN** a database error occurs during `CREATE SCHEMA`
- **WHEN** provisioning fails mid-flight
- **THEN** the system rolls back `public.tenants` and `public.profiles` inserts and returns HTTP 500

##### Scenario: Auth failure
- **GIVEN** an invalid or expired Supabase JWT
- **WHEN** provisioning is attempted
- **THEN** the system returns HTTP 401

---

## ADDED: Tenant Deletion
**Status**: proposed
**Priority**: P0

### Requirements

#### REQ-T003: Clean Tenant Removal
**Priority**: P0
The system MUST remove all tenant resources atomically: `DROP SCHEMA tenant_x CASCADE`, `DELETE FROM analytics.link_clicks WHERE tenant_id = x`, delete registry rows from `public.tenants` and `public.profiles`, invalidate all associated KV cache keys, and remove the Supabase Auth user.

##### Scenario: Full deletion
- **GIVEN** an active tenant with links and click data
- **WHEN** an authorized deletion request is processed
- **THEN** the tenant schema is dropped, all analytics rows are deleted, registry records are removed, KV cache is invalidated, and the Auth user is deleted

##### Scenario: Tenant not found
- **GIVEN** a tenant ID that does not exist in `public.tenants`
- **WHEN** deletion is requested
- **THEN** the system returns HTTP 404

##### Scenario: Unauthorized deletion
- **GIVEN** a JWT belonging to a user who is not the tenant owner or admin
- **WHEN** deletion is requested for another tenant
- **THEN** the system returns HTTP 403

##### Scenario: Partial failure — KV unavailable
- **GIVEN** KV is unreachable during deletion
- **WHEN** database cleanup succeeds
- **THEN** the system logs the KV failure and proceeds; KV keys expire via TTL

---

## ADDED: Link Creation API
**Status**: proposed
**Priority**: P0

### Requirements

#### REQ-L001: Authenticated Link Creation
**Priority**: P0
The system MUST accept `POST /api/links` with a Supabase JWT, resolve the tenant schema from the JWT, validate the `original_url`, generate a 7-character nanoid short code, insert into the tenant's `links` table, populate KV cache, and return the created link resource.

##### Scenario: Happy path
- **GIVEN** a valid JWT and `{ "original_url": "https://example.com" }`
- **WHEN** `POST /api/links` is called
- **THEN** the system returns HTTP 201 with `{ id, short_code, original_url, short_url, created_at }` and the KV cache contains `short_code → original_url`

##### Scenario: Missing authentication
- **GIVEN** no `Authorization` header is present
- **WHEN** `POST /api/links` is called
- **THEN** the system returns HTTP 401 with `{ error: "unauthenticated" }`

##### Scenario: Invalid URL format
- **GIVEN** a valid JWT and `{ "original_url": "not-a-url" }`
- **WHEN** `POST /api/links` is called
- **THEN** the system returns HTTP 400 with `{ error: "invalid_url" }`

##### Scenario: Short code collision
- **GIVEN** nanoid generation produces a code already in the tenant schema
- **WHEN** the `INSERT` hits a UNIQUE violation
- **THEN** the system retries generation up to 3 times before returning HTTP 500

##### Scenario: Schema not resolved
- **GIVEN** a JWT whose user has no associated tenant
- **WHEN** `POST /api/links` is called
- **THEN** the system returns HTTP 404 with `{ error: "tenant_not_found" }`

---

## ADDED: Link Limit Enforcement
**Status**: proposed
**Priority**: P0

### Requirements

#### REQ-L002: Free-Tier Link Cap
**Priority**: P0
The system MUST enforce a maximum of 30 active links per tenant on the free tier by counting active links before every creation attempt.

##### Scenario: Under limit
- **GIVEN** a tenant has 15 active links
- **WHEN** a new link is created
- **THEN** creation succeeds normally

##### Scenario: At limit
- **GIVEN** a tenant has 30 active links
- **WHEN** a new link creation is attempted
- **THEN** the system returns HTTP 429 with `{ error: "link_limit_reached", limit: 30 }`

##### Scenario: Inactive links excluded
- **GIVEN** a tenant has 30 total links but 5 are `is_active = false`
- **WHEN** a new link is created
- **THEN** creation succeeds (only 25 active links counted)

---

## ADDED: Link Lifecycle
**Status**: proposed
**Priority**: P0

### Requirements

#### REQ-L003: Activation and Expiration
**Priority**: P0
The system MUST default `is_active` to `true` on creation, MUST honor an optional `expires_at` timestamp, and MUST prevent redirects for inactive or expired links.

##### Scenario: Active link redirects
- **GIVEN** a link with `is_active = true` and `expires_at IS NULL`
- **WHEN** the redirect handler evaluates the link
- **THEN** the redirect proceeds normally

##### Scenario: Inactive link rejected
- **GIVEN** a link with `is_active = false`
- **WHEN** the redirect handler evaluates the link
- **THEN** the system returns HTTP 410 Gone

##### Scenario: Expired link rejected
- **GIVEN** a link with `expires_at` in the past
- **WHEN** the redirect handler evaluates the link
- **THEN** the system returns HTTP 410 Gone

##### Scenario: Future expiry still valid
- **GIVEN** a link with `expires_at` 30 days in the future
- **WHEN** the redirect handler evaluates the link
- **THEN** the redirect proceeds normally

---

## ADDED: Redirect Handler
**Status**: proposed
**Priority**: P0

### Requirements

#### REQ-R001: Path-Based Redirect with Caching
**Priority**: P0
The system MUST handle `GET /r/{tenant}/{code}` by extracting the tenant slug, resolving the schema name via KV cache (1h TTL), looking up the short code in KV cache (24h TTL) for the original URL, and returning HTTP 301. On cache miss it MUST query the database via Hyperdrive and populate both caches.

##### Scenario: Full cache hit
- **GIVEN** tenant slug "acme" maps to schema "tenant_a7f3" in KV, and code "abc123" maps to a URL in KV
- **WHEN** `GET /r/acme/abc123` is requested
- **THEN** the system returns HTTP 301 to the original URL and fires `ctx.waitUntil(trackClick)`

##### Scenario: KV miss, database hit
- **GIVEN** short code "abc123" is not in KV but exists in the tenant schema
- **WHEN** `GET /r/acme/abc123` is requested
- **THEN** the system queries Hyperdrive, returns HTTP 301, populates KV, and fires click tracking

##### Scenario: Code not found
- **GIVEN** short code "xyz999" does not exist in KV or the tenant schema
- **WHEN** `GET /r/acme/xyz999` is requested
- **THEN** the system returns HTTP 404

##### Scenario: Database failure
- **GIVEN** a Hyperdrive query error occurs during a cache miss
- **WHEN** the redirect handler runs
- **THEN** the system returns HTTP 503 and logs a structured error

---

## ADDED: Tenant Resolution Strategy
**Status**: proposed
**Priority**: P0

### Requirements

#### REQ-R002: Pluggable Tenant Extraction
**Priority**: P0
The system MUST extract the tenant slug from the request using a pluggable strategy interface. The MVP implementation MUST parse the path segment `/r/{tenant}/{code}`. The design MUST allow swapping for subdomain extraction without changing redirect or API logic.

##### Scenario: Path-based extraction
- **GIVEN** a request to `/r/acme/abc123`
- **WHEN** `extractTenantSlug(request)` executes
- **THEN** it returns the string "acme"

##### Scenario: KV lookup resolves schema
- **GIVEN** slug "acme" with KV entry `slug → "tenant_a7f3"`
- **WHEN** the redirect handler resolves the tenant
- **THEN** all subsequent queries use the fully-qualified table name `tenant_a7f3.links`

##### Scenario: KV miss queries registry
- **GIVEN** slug "acme" is not in KV
- **WHEN** the redirect handler resolves the tenant
- **THEN** it queries `public.tenants WHERE subdomain = 'acme' AND is_active = true`, caches the result in KV, and uses the resolved schema name

##### Scenario: Unknown tenant
- **GIVEN** slug "nonexistent" is not in KV and not in `public.tenants`
- **WHEN** the redirect handler resolves the tenant
- **THEN** the system returns HTTP 404

---

## ADDED: Click Analytics Tracking
**Status**: proposed
**Priority**: P0

### Requirements

#### REQ-A001: Non-Blocking Click Recording
**Priority**: P0
The system MUST record click events asynchronously via `ctx.waitUntil()`. It MUST extract country and device type from Cloudflare headers, a summary from User-Agent (not the raw string), and referrer with query parameters stripped. It MUST insert into `analytics.link_clicks` and atomically increment `clicks_count`. Failures MUST be logged and MUST NOT affect the redirect response.

##### Scenario: Successful tracking
- **GIVEN** a redirect response is about to be sent
- **WHEN** `ctx.waitUntil(trackClick(...))` fires
- **THEN** a row is inserted into `analytics.link_clicks` with `tenant_id`, `link_id`, country, device type, referrer, and user agent summary; `links.clicks_count` is incremented atomically

##### Scenario: Analytics failure does not block redirect
- **GIVEN** the analytics database is unreachable
- **WHEN** `trackClick` throws an error
- **THEN** the error is logged as structured JSON and the redirect response is sent with HTTP 301 regardless

##### Scenario: Referrer query params stripped
- **GIVEN** the request has `Referer: https://google.com/search?q=test`
- **WHEN** the click is recorded
- **THEN** only `https://google.com/search` is stored in the `referrer` column

---

## ADDED: Privacy
**Status**: proposed
**Priority**: P0

### Requirements

#### REQ-A002: IP Hashing
**Priority**: P0
The system MUST hash every client IP using SHA-256 with a per-tenant salt before storage. Raw IP addresses MUST NOT be stored in any form.

##### Scenario: IP is hashed before storage
- **GIVEN** a request with `CF-Connecting-IP: 1.2.3.4`
- **WHEN** a click event is recorded
- **THEN** the `ip_hash` column stores `SHA-256("1.2.3.4" + per_tenant_salt)` and no raw IP is persisted

##### Scenario: Missing IP header
- **GIVEN** the `CF-Connecting-IP` header is absent
- **WHEN** a click event is recorded
- **THEN** the `ip_hash` column stores `NULL` and tracking proceeds without error

---

## ADDED: Open Redirect Protection
**Status**: proposed
**Priority**: P0

### Requirements

#### REQ-S001: URL Validation on Creation
**Priority**: P0
The system MUST validate `original_url` on link creation: only `http:` and `https:` protocols are allowed; hostnames `localhost`, `127.0.0.1`, `0.0.0.0`, and `[::1]` are blocked; private IP ranges (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`) are blocked; maximum length is 2048 characters; the URL must parse via `new URL()`.

##### Scenario: Valid HTTPS URL
- **GIVEN** `original_url` is "https://example.com/page"
- **WHEN** validated
- **THEN** the URL is accepted

##### Scenario: Blocked protocol
- **GIVEN** `original_url` is "ftp://files.example.com"
- **WHEN** validated
- **THEN** the system rejects with `{ error: "invalid_protocol" }`

##### Scenario: Localhost blocked
- **GIVEN** `original_url` is "http://localhost:3000/admin"
- **WHEN** validated
- **THEN** the system rejects with `{ error: "blocked_host" }`

##### Scenario: Private IP blocked
- **GIVEN** `original_url` is "http://192.168.1.1/config"
- **WHEN** validated
- **THEN** the system rejects with `{ error: "blocked_ip_range" }`

##### Scenario: Oversized URL
- **GIVEN** `original_url` exceeds 2048 characters
- **WHEN** validated
- **THEN** the system rejects with `{ error: "url_too_long" }`

---

## ADDED: Abuse Prevention
**Status**: proposed
**Priority**: P0

### Requirements

#### REQ-S002: Creation Limits and Collision Handling
**Priority**: P0
The system MUST enforce the free-tier link cap (30 active links) by counting before creation, and MUST handle short code collisions by retrying nanoid generation up to 3 times.

##### Scenario: Short code collision — retry succeeds
- **GIVEN** the first nanoid generated collides with an existing code
- **WHEN** the system retries generation
- **THEN** a unique code is produced on the second attempt and the link is created

##### Scenario: Short code collision — retries exhausted
- **GIVEN** three consecutive nanoid generations all collide
- **WHEN** all retries are exhausted
- **THEN** the system returns HTTP 500 with `{ error: "link_creation_failed" }`

##### Scenario: Active link count uses correct scope
- **GIVEN** a tenant with 28 active and 5 inactive links
- **WHEN** the system counts active links before creation
- **THEN** it counts 28, not 33

---

## ADDED: Observability
**Status**: proposed
**Priority**: P0

### Requirements

#### REQ-O001: Structured JSON Logging
**Priority**: P0
The system MUST emit structured JSON log entries for every request. Redirect logs MUST include `{ event, code, tenant, cacheHit, durationMs, status }`. Error logs MUST include `{ event: "error", type, message, code, tenant }`. Raw IPs, full User-Agent strings, and other PII MUST NOT appear in any log.

##### Scenario: Redirect log on cache hit
- **GIVEN** a redirect at 3ms with a KV cache hit
- **WHEN** the response is sent
- **THEN** the log contains `{ "event": "redirect", "code": "abc123", "tenant": "acme", "cacheHit": true, "durationMs": 3, "status": 301 }`

##### Scenario: Error log on database failure
- **GIVEN** a Hyperdrive query fails with "connection refused"
- **WHEN** the error is caught
- **THEN** the log contains `{ "event": "error", "type": "db_query_failed", "message": "connection refused", "code": "abc123", "tenant": "acme" }`

##### Scenario: No PII in logs
- **GIVEN** any request with a client IP and full User-Agent
- **WHEN** the system logs the request
- **THEN** neither the raw IP nor the raw User-Agent string appears in the log output

---

## ADDED: Error Resilience
**Status**: proposed
**Priority**: P0

### Requirements

#### REQ-O002: Graceful Degradation
**Priority**: P0
The system MUST degrade gracefully: analytics failures MUST NOT block redirects, KV unavailability MUST fall through to database queries, and database failures MUST return HTTP 503 with a logged error.

##### Scenario: Analytics swallows errors
- **GIVEN** the analytics database is unreachable
- **WHEN** `ctx.waitUntil(trackClick)` fails
- **THEN** the redirect still returns HTTP 301; the error is logged; the user is unaffected

##### Scenario: KV unavailable
- **GIVEN** the KV namespace returns an error
- **WHEN** the redirect handler runs
- **THEN** it falls through to a Hyperdrive query; the response is served; the KV error is logged

##### Scenario: Database unavailable
- **GIVEN** both KV and Hyperdrive are unavailable
- **WHEN** the redirect handler runs
- **THEN** the system returns HTTP 503 and logs a structured error

---

## ADDED: Landing Page
**Status**: proposed
**Priority**: P0

### Requirements

#### REQ-LP001: Static Landing Page at Root
**Priority**: P0
The system MUST serve a lightweight, responsive HTML landing page at `GET /` containing the service name, a brief description, and links to Supabase Auth sign-up and login. The page MUST use no external dependencies beyond basic CSS and MUST adapt to mobile viewports.

##### Scenario: Root path serves landing page
- **GIVEN** a browser requests `GET /`
- **WHEN** the Worker handles the request
- **THEN** it returns HTTP 200 with HTML containing the service name, description, and links to sign up and log in

##### Scenario: Mobile responsiveness
- **GIVEN** a viewport width of 375px
- **WHEN** the landing page renders
- **THEN** content reflows without horizontal scrolling and all links remain tappable

##### Scenario: No external dependencies
- **GIVEN** the landing page HTML response
- **WHEN** inspected
- **THEN** it contains no `<script>` tags, no external CSS links, and no framework imports
