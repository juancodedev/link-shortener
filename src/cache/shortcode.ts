import type { AppEnv } from "../types/env";

/** TTL for short URL cache entries: 24 hours in seconds. */
const SHORT_URL_TTL = 86400;

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
