import type { MiddlewareHandler, Context } from "hono";
import type { AppEnv, HonoVars } from "../types/env";
import { withClient } from "../db/client";
import { validateSchemaName } from "../db/schema";
import { getCachedSchema, setCachedTenant } from "../cache/tenant";

// ---------------------------------------------------------------------------
// Pluggable tenant extraction strategy
// ---------------------------------------------------------------------------

/**
 * Strategy interface for extracting the tenant slug from a request.
 * Allows swapping path-based routing for subdomain-based without changing
 * handlers or the tenant middleware.
 */
export interface TenantResolutionStrategy {
  /** Extracts the tenant slug from the Hono request context. */
  extractTenantSlug(c: Context): string;
}

/**
 * Path-based tenant resolution strategy (MVP).
 *
 * Extracts the tenant slug from the URL path segment `/r/{tenant}/{code}`.
 * Hono's router captures the `{tenant}` param and makes it available via
 * `c.req.param('tenant')`.
 */
export class PathBasedStrategy implements TenantResolutionStrategy {
  extractTenantSlug(c: Context): string {
    return c.req.param("tenant") ?? "";
  }
}

// ---------------------------------------------------------------------------
// Tenant resolution middleware
// ---------------------------------------------------------------------------

/**
 * Type for the shared env + vars used by this middleware.
 */
type TenantEnv = { Bindings: AppEnv; Variables: HonoVars };

/**
 * Creates tenant resolution middleware using the supplied strategy.
 *
 * Flow:
 * 1. Extract tenant slug via the strategy
 * 2. Check TENANT_CACHE (KV) — if hit, validate with regex and use
 * 3. Cache miss → query `public.tenants` via Hyperdrive
 * 4. Found → cache in KV (fire-and-forget) + set context
 * 5. Not found → 404
 *
 * @param strategy - How to extract the tenant slug from the request
 */
export function createTenantMiddleware(
  strategy: TenantResolutionStrategy,
): MiddlewareHandler<TenantEnv> {
  return async (c, next) => {
    const slug = strategy.extractTenantSlug(c);

    // Guard: empty slug immediately resolves to 404
    if (!slug) {
      return c.json({ error: "tenant_not_found" }, 404);
    }

    // --- 1. KV cache lookup ---
    const cachedSchema = await getCachedSchema(c.env, slug);

    if (cachedSchema !== null) {
      // Validate the cached value before any SQL use (defense-in-depth)
      let schemaValid = true;
      try {
        validateSchemaName(cachedSchema);
      } catch {
        schemaValid = false;
        console.error(
          JSON.stringify({
            event: "error",
            type: "invalid_cached_schema",
            message: `Cached schema name "${cachedSchema}" for slug "${slug}" failed validation`,
            tenant: slug,
          }),
        );
        // Fall through to database lookup — don't trust the bad cache entry
      }

      if (schemaValid) {
        // We need tenantId but KV only stores schemaName for MVP.
        // For the redirect handler, tenantId is extracted from the DB row
        // further down. Here we set what we have; tenantId will be resolved
        // by the caller when needed.
        c.set("tenant", {
          tenantSlug: slug,
          schemaName: cachedSchema,
          tenantId: "", // Resolved by handler when needed
          tenantSalt: "", // Not available from KV cache; resolved by handler
        });
        return await next();
      }
    }

    // --- 2. Cache miss — query public.tenants via Hyperdrive ---
    try {
      const result = await withClient(c.env, async (client) => {
        const query = `
          SELECT id, schema_name, salt
          FROM public.tenants
          WHERE subdomain = $1 AND is_active = true
          LIMIT 1
        `;
        const res = await client.query<{
          id: string;
          schema_name: string;
          salt: string;
        }>(query, [slug]);
        return res.rows;
      });

      if (result.length === 0) {
        return c.json({ error: "tenant_not_found" }, 404);
      }

      const { id: tenantId, schema_name: schemaName, salt: tenantSalt } = result[0]!;

      // Validate schema name from database (defense-in-depth)
      try {
        validateSchemaName(schemaName);
      } catch {
        console.error(
          JSON.stringify({
            event: "error",
            type: "invalid_db_schema",
            message: `Schema name "${schemaName}" for slug "${slug}" failed validation`,
            tenant: slug,
          }),
        );
        return c.json({ error: "internal_error" }, 500);
      }

      // --- 3. Populate KV cache (fire-and-forget through waitUntil) ---
      c.executionCtx.waitUntil(
        setCachedTenant(c.env, slug, { schemaName, tenantId, tenantSalt }).catch((err) => {
          console.error(
            JSON.stringify({
              event: "error",
              type: "kv_write_failed",
              message: err instanceof Error ? err.message : String(err),
              tenant: slug,
            }),
          );
        }),
      );

      // --- 4. Set context ---
      c.set("tenant", {
        tenantSlug: slug,
        schemaName,
        tenantId,
        tenantSalt,
      });

      return await next();
    } catch (err) {
      console.error(
        JSON.stringify({
          event: "error",
          type: "db_query_failed",
          message: err instanceof Error ? err.message : String(err),
          tenant: slug,
        }),
      );
      return c.json({ error: "service_unavailable" }, 503);
    }
  };
}

// ---------------------------------------------------------------------------
// User-profile-based tenant resolution (API endpoints)
// ---------------------------------------------------------------------------

/**
 * Creates tenant resolution middleware for API endpoints where the tenant
 * is resolved from the authenticated user's profile (not from a URL path).
 *
 * Flow:
 * 1. Read `c.get('user').userId` (set by auth middleware)
 * 2. Query `public.profiles JOIN public.tenants` via Hyperdrive
 * 3. Found → check KV cache → populate if miss → set context
 * 4. Not found → 404 (user has no tenant/profile)
 *
 * This is used on `/api/links` where the tenant cannot be extracted from
 * the URL path since the path does not contain a tenant slug.
 */
export function createUserProfileTenantMiddleware(): MiddlewareHandler<TenantEnv> {
  return async (c, next) => {
    const user = c.get("user");
    if (!user?.userId) {
      return c.json({ error: "unauthenticated" }, 401);
    }

    try {
      const result = await withClient(c.env, async (client) => {
        const query = `
          SELECT t.id, t.schema_name, t.subdomain, t.salt
          FROM public.profiles p
          JOIN public.tenants t ON p.tenant_id = t.id
          WHERE p.id = $1 AND t.is_active = true
          LIMIT 1
        `;
        const res = await client.query<{
          id: string;
          schema_name: string;
          subdomain: string;
          salt: string;
        }>(query, [user.userId]);
        return res.rows;
      });

      if (result.length === 0) {
        return c.json({ error: "tenant_not_found" }, 404);
      }

      const { id: tenantId, schema_name: schemaName, subdomain, salt: tenantSalt } = result[0]!;

      // Validate schema name from database (defense-in-depth)
      try {
        validateSchemaName(schemaName);
      } catch {
        console.error(
          JSON.stringify({
            event: "error",
            type: "invalid_db_schema",
            message: `Schema name "${schemaName}" for user "${user.userId}" failed validation`,
          }),
        );
        return c.json({ error: "internal_error" }, 500);
      }

      // Populate KV cache (fire-and-forget through waitUntil)
      c.executionCtx.waitUntil(
        setCachedTenant(c.env, subdomain, { schemaName, tenantId, tenantSalt }).catch((err) => {
          console.error(
            JSON.stringify({
              event: "error",
              type: "kv_write_failed",
              message: err instanceof Error ? err.message : String(err),
              tenant: subdomain,
            }),
          );
        }),
      );

      c.set("tenant", {
        tenantSlug: subdomain,
        schemaName,
        tenantId,
        tenantSalt,
      });

      return await next();
    } catch (err) {
      console.error(
        JSON.stringify({
          event: "error",
          type: "db_query_failed",
          message: err instanceof Error ? err.message : String(err),
          userId: user.userId,
        }),
      );
      return c.json({ error: "service_unavailable" }, 503);
    }
  };
}
