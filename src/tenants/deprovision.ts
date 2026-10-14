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

    // A profile is NOT deleted here, and that is a deliberate change of behaviour.
    //
    // Before tenant_memberships, one profile belonged to exactly one tenant, so
    // deleting the tenant could delete the profile — and, because profiles.id
    // references auth.users ON DELETE CASCADE, the user's login went with it.
    //
    // With memberships that is no longer true. A person in a forty-store chain
    // has one profile and forty membership rows; removing them from one store
    // must delete that store's membership and nothing else. Deleting the
    // profile would cascade from auth.users and lock the person out of the
    // other thirty-nine stores they still legitimately run.
    //
    // tenant_memberships.tenant_id is ON DELETE CASCADE, so the membership for
    // this tenant disappears with the tenant row on its own. The only profile
    // that should ever be removed is one with no memberships left anywhere,
    // which is handled below.
    const orphaned = await client.query<{ id: string }>(
      `DELETE FROM public.profiles p
        WHERE p.tenant_id = $1
          AND NOT EXISTS (
            SELECT 1 FROM public.tenant_memberships m WHERE m.profile_id = p.id
          )
        RETURNING p.id`,
      [tenantId],
    );

    // Deleting a profile cascades to auth.users, so the account is destroyed
    // too. Reported so the operator knows a login was removed, not just a row.
    if (orphaned.rows.length > 0) {
      console.warn(
        JSON.stringify({
          event: "warning",
          type: "profile_deleted_no_memberships",
          count: orphaned.rows.length,
          tenantId,
        }),
      );
    }

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
  // ONLY when the owner has no memberships left anywhere.
  //
  // ORDER MATTERS, and 00012 makes it load-bearing: `tenants.owner_id` is
  // ON DELETE RESTRICT, so the tenant row must already be gone (step 1) before
  // this call can succeed. Deleting the account first would now fail on the
  // foreign key — which is the correct outcome, but it would leave the tenant
  // alive and the account stuck. The steps above run in one transaction, so a
  // failure anywhere above rolls the whole thing back.
  //
  // This was unconditional, and with one profile per tenant that was correct:
  // the owner of the only tenant was about to lose access to it, so deleting
  // the login matched the intent.
  //
  // With memberships it is not. A person running a chain owns several tenants
  // and has one login. Removing one store used to destroy the account and with
  // it their access to every other store they legitimately run — a data-loss
  // bug that only appears once the second tenant exists, which is exactly when
  // it is least likely to be noticed.
  //
  // The check below mirrors the profile deletion above: the account goes when
  // the last membership goes, and not before.
  ctx.waitUntil(
    (async () => {
      try {
        const remaining = await withClient(env, async (client) => {
          const res = await client.query<{ n: number }>(
            `SELECT COUNT(*)::int AS n
               FROM public.tenant_memberships m
               JOIN public.tenants t ON t.id = m.tenant_id
              WHERE m.profile_id = $1 AND t.is_active = true`,
            [ownerUserId],
          );
          return res.rows[0]?.n ?? 0;
        });

        if (remaining > 0) {
          console.warn(
            JSON.stringify({
              event: "warning",
              type: "auth_user_kept_other_memberships",
              ownerUserId,
              remaining,
              tenantId,
            }),
          );
          return;
        }

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
