import type { AppEnv } from "../types/env";
import { withClient } from "../db/client";
import { buildQuery } from "../db/schema";
import { invalidateCachedSchema } from "../cache/tenant";
import {
  invalidateCachedUrl,
  invalidateCachedRegistryEntry,
} from "../cache/shortcode";

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

/**
 * Deprovisions a tenant: drops the per-tenant schema, cleans up analytics
 * and registry rows, deletes the Supabase Auth user, and invalidates KV cache.
 *
 * **DB operations** run in a single transaction. If any DB step fails, the
 * entire transaction is rolled back (client throws → connection ends → uncommitted
 * work is discarded).
 *
 * **Post-DB side effects** (Auth user deletion and KV invalidation) execute
 * AFTER the DB transaction commits. Their failures are non-fatal:
 * - Auth user deletion failure → logged, DB cleanup is not rolled back.
 * - KV invalidation failure → logged, entries expire via TTL (1h / 24h).
 *
 * The short-code registry cleanup RETURNS the codes it removed so the
 * corresponding KV entries can be invalidated here. `ON DELETE CASCADE` would
 * have removed the rows anyway; returning them is the point.
 *
 * Auth user deletion is fire-and-forget via `ctx.waitUntil`.

 * @param env          - Worker environment (bindings)
 * @param tenantId     - UUID of the tenant in `public.tenants`
 * @param schemaName   - Per-tenant schema name (e.g., "tenant_a7f3d2b1")
 * @param subdomain    - Tenant subdomain slug
 * @param ownerUserId  - UUID of the tenant owner (Supabase Auth user)
 * @param ctx          - ExecutionContext for waitUntil side effects
 */
export async function deprovisionTenant(
  env: AppEnv,
  tenantId: string,
  schemaName: string,
  subdomain: string,
  ownerUserId: string,
  ctx: { waitUntil(promise: Promise<unknown>): void },
): Promise<void> {
  // --- 1. DB transaction: drop all tenant resources ---
  const removedShortCodes = await withClient(env, async (client) => {
    // Drop the per-tenant schema (CASCADE removes links, indexes, _migrations)
    await client.query(buildQuery(schemaName, `DROP SCHEMA IF EXISTS {schema} CASCADE`));

    // Clean analytics for this tenant
    await client.query(
      `DELETE FROM analytics.link_clicks WHERE tenant_id = $1`,
      [tenantId],
    );

    // Clean registry: profiles (CASCADE from tenants, but explicit for clarity)
    await client.query(
      `DELETE FROM public.profiles WHERE tenant_id = $1`,
      [tenantId],
    );

    // Clean registry: short codes + the tenant row, in ONE statement.
    //
    // The foreign key on short_code_registry.tenant_id is ON DELETE CASCADE, so
    // deleting the tenant row alone would remove the codes anyway. They are
    // deleted explicitly here for a different reason: `removed_codes` RETURNS
    // them, and those values are the only way to invalidate the KV entries that
    // would otherwise keep resolving a tenant whose schema no longer exists.
    //
    // One statement keeps it inside the transaction and leaves the query order
    // above untouched.
    //
    // `removed_tenant` is deliberately unreferenced by the outer SELECT. That is
    // not an oversight: PostgreSQL runs every data-modifying CTE exactly once and
    // to completion regardless of whether the primary query reads its output, so
    // the DELETE happens. Selecting from it would change nothing — drop it only
    // if you also mean to stop deleting the tenant.
    const removed = await client.query<{ short_code: string }>(
      `WITH removed_codes AS (
         DELETE FROM public.short_code_registry WHERE tenant_id = $1
         RETURNING short_code
       ),
       removed_tenant AS (
         DELETE FROM public.tenants WHERE id = $1
         RETURNING id
       )
       SELECT short_code FROM removed_codes`,
      [tenantId],
    );

    return removed.rows.map((r) => r.short_code);
  });

  // --- 2. Delete Supabase Auth user (fire-and-forget, non-fatal) ---
  ctx.waitUntil(
    (async () => {
      try {
        const adminUrl = `${env.SUPABASE_URL}/auth/v1/admin/users/${ownerUserId}`;
        const response = await fetch(adminUrl, {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
            "Content-Type": "application/json",
          },
        });

        if (!response.ok && response.status !== 404) {
          console.error(
            JSON.stringify({
              event: "error",
              type: "auth_user_deletion_failed",
              message: `Supabase Admin API returned ${response.status}`,
              tenantId,
              ownerUserId,
            }),
          );
        }
      } catch (err) {
        console.error(
          JSON.stringify({
            event: "error",
            type: "auth_user_deletion_failed",
            message: err instanceof Error ? err.message : String(err),
            tenantId,
            ownerUserId,
          }),
        );
      }
    })(),
  );

  // --- 3. Invalidate KV cache (fire-and-forget, non-fatal) ---
  ctx.waitUntil(
    invalidateCachedSchema(env, subdomain).catch((err) => {
      console.error(
        JSON.stringify({
          event: "error",
          type: "kv_invalidation_failed",
          message: err instanceof Error ? err.message : String(err),
          tenant: subdomain,
        }),
      );
    }),
  );

  // --- 4. Invalidate every short link this tenant owned (non-fatal) ---
  //
  // Both cache layers are cleared per code: the registry entry (which would
  // otherwise resolve to a dropped schema and surface as a 503 on the link's
  // URL) and the short-URL entry (which would keep returning the old
  // destination for up to 24h).
  //
  // No codes means nothing was ever created, so this is skipped entirely.
  if (removedShortCodes.length > 0) {
    ctx.waitUntil(
      Promise.all(
        removedShortCodes.flatMap((code) => [
          invalidateCachedRegistryEntry(env, code),
          invalidateCachedUrl(env, subdomain, code),
        ]),
      ).catch((err) => {
        console.error(
          JSON.stringify({
            event: "error",
            type: "kv_invalidation_failed",
            message: err instanceof Error ? err.message : String(err),
            tenant: subdomain,
            codes: removedShortCodes.length,
          }),
        );
      }),
    );
  }
}
