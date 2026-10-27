import type { AppEnv } from "../types/env";

/** TTL for short URL cache entries: 24 hours in seconds. */
const SHORT_URL_TTL = 86400;

/**
 * TTL for registry entries: 15 minutes in seconds.
 *
 * The registry entry carries `subscriptionStatus`, so it holds billing state --
 * a much stronger claim than "this code resolves to this URL". KV deletes are
 * eventually consistent, and when a delete fails to propagate the TTL is the
 * ONLY backstop. At 24h that backstop is a 24-hour window on serving stale
 * billing state, which is not a backstop at all.
 *
 * The short-URL entry is left at 24h: the redirect reads the link row from
 * Postgres on every scan and serves that entry only when the query fails, so
 * its age decides how old an outage snapshot can be, never what a normal scan
 * sees.
 *
 * This makes the WORST case bounded without adding a query per scan. It does
 * not make the COMMON case fast -- if reactivations feel slow, that is this
 * TTL and the honest fix is reading billing state straight from Postgres.
 */
const REGISTRY_TTL = 900;

/**
 * Builds the KV key for a short URL cache entry.
 * Format: `{tenantSlug}:{shortCode}`
 */
function cacheKey(tenantSlug: string, shortCode: string): string {
  return `${tenantSlug}:${shortCode}`;
}

/**
 * Retrieves a cached original URL for a given tenant slug and short code.
 * Returns null on cache miss or KV error — never throws.
 */
export async function getCachedUrl(
  env: AppEnv,
  tenantSlug: string,
  shortCode: string,
): Promise<string | null> {
  try {
    return await env.SHORT_URL_CACHE.get(cacheKey(tenantSlug, shortCode));
  } catch {
    // KV unavailable — graceful degradation to database query
    return null;
  }
}

/**
 * Caches a short_code → original_url mapping with 24h TTL.
 * Called via ctx.waitUntil() — never awaited inline on the critical path.
 * Errors are caught and logged, never thrown.
 */
export async function setCachedUrl(
  env: AppEnv,
  tenantSlug: string,
  shortCode: string,
  originalUrl: string,
): Promise<void> {
  try {
    await env.SHORT_URL_CACHE.put(cacheKey(tenantSlug, shortCode), originalUrl, {
      expirationTtl: SHORT_URL_TTL,
    });
  } catch {
    // KV write failure is non-fatal — redirect falls back to database
  }
}

/**
 * Invalidates a cached short URL entry.
 * Called via ctx.waitUntil() during link deletion or deprovisioning.
 */
export async function invalidateCachedUrl(
  env: AppEnv,
  tenantSlug: string,
  shortCode: string,
): Promise<void> {
  try {
    await env.SHORT_URL_CACHE.delete(cacheKey(tenantSlug, shortCode));
  } catch {
    // KV deletion failure is non-fatal — entry expires via TTL
  }
}

// ---------------------------------------------------------------------------
// Short-code registry cache
//
// Public links are flat (`/<code>`), so a redirect starts by turning a bare code
// into a tenant. That lookup is a join against public.short_code_registry on
// every cold request, and the answer is stable for the lifetime of the link —
// the same shape of problem, and the same cache, as the short URL entry above.
//
// It reuses SHORT_URL_CACHE rather than adding a namespace: same 24h TTL, same
// key-value discipline, one less binding to provision and monitor.
//
// Keyed by the code ALONE, not `{slug}:{code}`. There is no slug in the URL any
// more, and short_code is globally unique by primary key, so a slug-qualified
// key would have nothing to qualify with. The `reg:` prefix keeps these entries
// from ever colliding with a `{slug}:{code}` short-URL entry.
// ---------------------------------------------------------------------------

const REGISTRY_KEY_PREFIX = "reg:";

/**
 * Builds the KV key for a registry entry.
 * Format: `reg:{shortCode}`
 */
function registryKey(shortCode: string): string {
  return `${REGISTRY_KEY_PREFIX}${shortCode}`;
}

/**
 * The tenant routing data needed to serve a short code without touching the
 * database. Deliberately excludes the destination URL: that stays in the
 * short-URL cache, which is invalidated independently (a link can be disabled
 * or expire without the tenant mapping changing).
 */
export interface CachedRegistryEntry {
  tenantId: string;
  schemaName: string;
  tenantSalt: string;
  /** Tenant slug — used to key the short-URL cache entry, and for logs. */
  subdomain: string;
  /** Registry's idea of the link id; null when the row was written without one. */
  linkId: string | null;
  /**
   * Business name for the action screen heading. Optional: a blob written
   * before this field existed has no such key, and the caller falls back to
   * `subdomain`.
   */
  displayName?: string;
}

/**
 * Retrieves the cached registry entry for a bare short code.
 * Returns null on cache miss, malformed value, or KV error — never throws.
 *
 * The caller MUST validate schemaName with validateSchemaName() before using it
 * in SQL. A cache entry is as untrusted as the row it came from.
 */
export async function getCachedRegistryEntry(
  env: AppEnv,
  shortCode: string,
): Promise<CachedRegistryEntry | null> {
  try {
    const raw = await env.SHORT_URL_CACHE.get(registryKey(shortCode));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CachedRegistryEntry>;
    if (!parsed.tenantId || !parsed.schemaName) return null;
    return parsed as CachedRegistryEntry;
  } catch {
    return null;
  }
}

/**
 * Caches a short-code → tenant mapping with the same 24h TTL as short URLs.
 * Called via ctx.waitUntil() after a registry hit; failures are swallowed so a
 * cache problem never turns into a failed redirect.
 */
export async function setCachedRegistryEntry(
  env: AppEnv,
  shortCode: string,
  entry: CachedRegistryEntry,
): Promise<void> {
  try {
    await env.SHORT_URL_CACHE.put(registryKey(shortCode), JSON.stringify(entry), {
      expirationTtl: REGISTRY_TTL,
    });
  } catch {
    // KV write failure is non-fatal — the next request reads the registry again
  }
}

/**
 * Invalidates a cached registry entry.
 * Called on link deletion and tenant deprovisioning, so a code freed or a tenant
 * removed does not keep resolving from cache. Failure is non-fatal.
 */
export async function invalidateCachedRegistryEntry(
  env: AppEnv,
  shortCode: string,
): Promise<void> {
  try {
    await env.SHORT_URL_CACHE.delete(registryKey(shortCode));
  } catch {
    // KV deletion failure is non-fatal — entry expires via TTL
  }
}
