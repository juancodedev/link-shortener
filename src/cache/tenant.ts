import type { AppEnv } from "../types/env";

/** TTL for tenant schema cache entries: 1 hour in seconds. */
const TENANT_SCHEMA_TTL = 3600;

export interface CachedTenant {
  schemaName: string;
  tenantId: string;
  tenantSalt: string;
}

/**
 * Retrieves the cached tenant info for a slug.
 * Returns null on cache miss or KV error — never throws.
 *
 * IMPORTANT: The caller MUST validate schemaName with
 * validateSchemaName() before using it in SQL queries.
 */
export async function getCachedTenant(
  env: AppEnv,
  slug: string,
): Promise<CachedTenant | null> {
  try {
    const raw = await env.TENANT_CACHE.get(slug);
    if (!raw) return null;
    return JSON.parse(raw) as CachedTenant;
  } catch {
    return null;
  }
}

/**
 * Caches tenant info (schemaName + tenantId + tenantSalt) with 1h TTL.
 * Called via ctx.waitUntil() after resolving a tenant from the database.
 */
export async function setCachedTenant(
  env: AppEnv,
  slug: string,
  tenant: CachedTenant,
): Promise<void> {
  try {
    await env.TENANT_CACHE.put(slug, JSON.stringify(tenant), {
      expirationTtl: TENANT_SCHEMA_TTL,
    });
  } catch {
    // KV write failure is non-fatal
  }
}

/**
 * Invalidates a cached tenant entry.
 * Called during tenant deprovisioning. Failure is non-fatal.
 */
export async function invalidateCachedTenant(
  env: AppEnv,
  slug: string,
): Promise<void> {
  try {
    await env.TENANT_CACHE.delete(slug);
  } catch {
    // KV deletion failure is non-fatal
  }
}

// Backward-compatible wrappers for code still using old API
export async function getCachedSchema(env: AppEnv, slug: string): Promise<string | null> {
  const t = await getCachedTenant(env, slug);
  return t?.schemaName ?? null;
}

export async function setCachedSchema(env: AppEnv, slug: string, schemaName: string): Promise<void> {
  await setCachedTenant(env, slug, { schemaName, tenantId: "", tenantSalt: "" });
}

export async function invalidateCachedSchema(env: AppEnv, slug: string): Promise<void> {
  await invalidateCachedTenant(env, slug);
}
