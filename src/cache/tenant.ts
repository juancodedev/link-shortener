import type { AppEnv } from "../types/env";

/** TTL for tenant schema cache entries: 1 hour in seconds. */
const TENANT_SCHEMA_TTL = 3600;

/**
 * Retrieves the cached schema name for a tenant slug.
 * Returns null on cache miss or KV error — never throws.
 *
 * IMPORTANT: The caller MUST validate the returned value with
 * validateSchemaName() before using it in SQL queries.
 */
export async function getCachedSchema(
  env: AppEnv,
  slug: string,
): Promise<string | null> {
  try {
    return await env.TENANT_CACHE.get(slug);
  } catch {
    // KV unavailable — graceful degradation to database query
    return null;
  }
}

/**
 * Caches a tenant_slug → schema_name mapping with 1h TTL.
 * Called via ctx.waitUntil() after resolving a tenant from the database
 * or during tenant provisioning.
 * Errors are caught and logged, never thrown.
 */
export async function setCachedSchema(
  env: AppEnv,
  slug: string,
  schemaName: string,
): Promise<void> {
  try {
    await env.TENANT_CACHE.put(slug, schemaName, {
      expirationTtl: TENANT_SCHEMA_TTL,
    });
  } catch {
    // KV write failure is non-fatal — tenant resolution falls back to database
  }
}

/**
 * Invalidates a cached tenant schema entry.
 * Called via ctx.waitUntil() during tenant deprovisioning.
 * Failure is non-fatal — the entry expires via TTL within 1 hour.
 */
export async function invalidateCachedSchema(
  env: AppEnv,
  slug: string,
): Promise<void> {
  try {
    await env.TENANT_CACHE.delete(slug);
  } catch {
    // KV deletion failure is non-fatal — entry expires via TTL
  }
}
