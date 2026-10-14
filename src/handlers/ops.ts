import type { Context, Handler } from "hono";
import type { AppEnv, HonoVars } from "../types/env";
import { withClient } from "../db/client";
import { invalidateCachedRegistryEntry } from "../cache/shortcode";

// ---------------------------------------------------------------------------
// Operator endpoints
//
// WHY A SEPARATE CREDENTIAL, NOT THE DASHBOARD
//
// Billing is per tag and off-platform: the operator collects payment and then
// records it here. A customer must never be able to flip their own
// `subscription_status`, because `active` is exactly what they would grant
// themselves instead of paying.
//
// So these routes are deliberately NOT reachable by a customer JWT, not even an
// owner's. They are authenticated by `OPERATIONS_TOKEN`, a secret held only by
// the operator and set through `wrangler secret put`.
//
// It is a dedicated token rather than reusing SUPABASE_SERVICE_ROLE_KEY on
// purpose. The service role key is full-database access; a credential that can
// only flip a subscription should not be able to drop a schema. The two
// capabilities have different blast radii and must not share a secret.
//
// It is also a separate GitHub Actions secret, so rotating the operator token
// does not touch the Supabase credentials and vice versa.
// ---------------------------------------------------------------------------

/** The only statuses a subscription may hold. Mirrors the CHECK in 00013. */
const VALID_STATUSES = new Set(["active", "past_due", "canceled"]);

/**
 * Compares two strings without leaking where they first differ.
 *
 * Both sides are hashed first so the comparison is over fixed-width digests:
 * a byte-wise loop over the raw strings would return early on the first
 * mismatch and its running time would tell an attacker how many leading
 * characters they had guessed correctly.
 */
async function tokensMatch(presented: string, expected: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(presented)),
    crypto.subtle.digest("SHA-256", enc.encode(expected)),
  ]);
  const da = new Uint8Array(a);
  const db = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < da.length; i++) diff |= da[i]! ^ db[i]!;
  return diff === 0;
}

/**
 * Shared gate for every operator route.
 *
 * Fail-closed on a missing token: if `OPERATIONS_TOKEN` is not configured the
 * route is unusable, which is the correct failure direction for a capability
 * that can restore billable service.
 */
async function requireOperator(
  c: Context<{ Bindings: AppEnv; Variables: HonoVars }>,
): Promise<Response | null> {
  const configured = c.env.OPERATIONS_TOKEN;
  if (!configured) {
    console.error(
      JSON.stringify({
        event: "error",
        type: "operations_token_missing",
        message: "OPERATIONS_TOKEN is not configured; operator routes are disabled",
      }),
    );
    return c.json({ error: "service_unavailable" }, 503);
  }

  const header = c.req.header("Authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7).trim() : "";

  if (!presented || !(await tokensMatch(presented, configured))) {
    return c.json({ error: "forbidden" }, 403);
  }
  return null;
}

/** Every tenant with the state an operator needs to decide who to chase. */
export const listTenantSubscriptions: Handler<{
  Bindings: AppEnv;
  Variables: HonoVars;
}> = async (c) => {
  const denied = await requireOperator(c);
  if (denied) return denied;

  try {
    const tenants = await withClient(c.env, async (client) => {
      const res = await client.query<{
        id: string;
        subdomain: string;
        display_name: string;
        subscription_status: string;
        is_active: boolean;
        links: string;
        updated_at: string | null;
      }>(
        `SELECT t.id,
                t.subdomain,
                t.display_name,
                t.subscription_status,
                t.is_active,
                COUNT(r.short_code)::text AS links,
                MAX(t.subscription_updated_at)::text AS updated_at
           FROM public.tenants t
           LEFT JOIN public.short_code_registry r ON r.tenant_id = t.id
          GROUP BY t.id, t.subdomain, t.display_name,
                   t.subscription_status, t.is_active,
                   t.subscription_updated_at
          ORDER BY t.subdomain`,
      );
      return res.rows;
    });

    return c.json({
      tenants: tenants.map((t) => ({
        id: t.id,
        slug: t.subdomain,
        name: t.display_name,
        // is_active and subscription_status are different facts and are
        // reported separately: "removed" and "unpaid" need different emails.
        status: t.subscription_status,
        isActive: t.is_active,
        tags: Number(t.links),
        updatedAt: t.updated_at,
      })),
    });
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "error",
        type: "ops_list_failed",
        message: err instanceof Error ? err.message : String(err),
      }),
    );
    return c.json({ error: "service_unavailable" }, 503);
  }
};

/**
 * Records a payment state change and invalidates the cached registry entries so
 * the new state is effective immediately rather than when a TTL expires.
 *
 * The flush is best-effort and that is safe: `reg:{code}` entries expire on
 * their own, and when they do the JOIN re-reads `subscription_status` from
 * Postgres, which is the source of truth. A missed delete costs at most the
 * remaining TTL of one code. Correctness never depends on this write.
 */
export const setTenantSubscription: Handler<{
  Bindings: AppEnv;
  Variables: HonoVars;
}> = async (c) => {
  const denied = await requireOperator(c);
  if (denied) return denied;

  let body: { slug?: string; status?: string };
  try {
    body = await c.req.json<{ slug?: string; status?: string }>();
  } catch {
    return c.json({ error: "invalid_request" }, 400);
  }

  if (!body.slug || !body.status || !VALID_STATUSES.has(body.status)) {
    return c.json({ error: "invalid_request" }, 400);
  }

  try {
    const updated = await withClient(c.env, async (client) => {
      const res = await client.query<{ id: string }>(
        `UPDATE public.tenants
            SET subscription_status = $1,
                subscription_updated_at = now()
          WHERE subdomain = $2
          RETURNING id`,
        [body.status, body.slug],
      );
      return res.rows;
    });

    const tenant = updated[0];
    if (!tenant) {
      return c.json({ error: "not_found" }, 404);
    }

    const codes = await withClient(c.env, async (client) => {
      const res = await client.query<{ short_code: string }>(
        `SELECT short_code FROM public.short_code_registry WHERE tenant_id = $1`,
        [tenant.id],
      );
      return res.rows.map((r) => r.short_code);
    });

    // allSettled, not all. The cache helper swallows its own errors today, but
    // a flush that made the whole request fail would turn a paid invoice into a
    // 500 and an operator retrying it into a second UPDATE. The status is
    // already committed by the time we get here; the flush is housekeeping.
    //
    // There is deliberately no "failed" counter: the helper never rejects, so
    // such a counter could only ever read zero. The TTL is the real safety net —
    // a delete that does not land expires on its own and the JOIN re-reads the
    // new status from Postgres.
    await Promise.allSettled(
      codes.map((code) => invalidateCachedRegistryEntry(c.env, code)),
    );

    return c.json({ slug: body.slug, status: body.status, tagsFlushed: codes.length });
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "error",
        type: "ops_update_failed",
        message: err instanceof Error ? err.message : String(err),
        slug: body.slug,
      }),
    );
    return c.json({ error: "service_unavailable" }, 503);
  }
};