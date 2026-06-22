import type { AppEnv } from "../types/env";
import { withClient } from "../db/client";
import { buildQuery } from "../db/schema";
import { invalidateCachedSchema } from "../cache/tenant";

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
 * - KV invalidation failure → logged, entries expire via TTL (1h).
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
  await withClient(env, async (client) => {
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

    // Clean registry: tenant row
    await client.query(
      `DELETE FROM public.tenants WHERE id = $1`,
      [tenantId],
    );
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
}
