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

// Membership-based tenant resolution (API endpoints)
// ---------------------------------------------------------------------------

/** Header a caller sets to choose which tenant a request operates on. */
export const TENANT_SELECTOR_HEADER = "X-Tenant-Slug";

interface MembershipRow {
  id: string;
  schema_name: string;
  subdomain: string;
  salt: string;
  role: string;
}

/**
 * Resolves which tenant an authenticated request operates on, from the
 * memberships that grant access rather than from `profiles.tenant_id`.
 *
 * WHY THE JOIN TABLE
 * `profiles.tenant_id` is NOT NULL and one profile had exactly one tenant, so
 * the old query could read it, return the only row, and be correct. The moment
 * a person belongs to two restaurants that query returns two rows and picking
 * one arbitrarily would make every route inherit that choice — the API would
 * answer a question the user never asked.
 *
 * HOW ISOLATION IS ACHIEVED
 * The `m.profile_id = $1` predicate is inside the SQL. Nothing is fetched and
 * then checked: there is no step where a handler could be handed another
 * tenant's data and fail to notice. Selecting a tenant the caller has no
 * membership in produces zero rows, which is why the refusal below must not
 * distinguish "not yours" from "does not exist" — that distinction would turn
 * this endpoint into an oracle for discovering which restaurants exist.
 *
 * SELECTION
 * `X-Tenant-Slug` names the tenant. With no header, a single membership is
 * used — so every existing single-restaurant user keeps working with no client
 * change at all. With several and no header, the request is refused with the
 * list rather than guessed, because guessing is the bug this replaces.
 */
export function createTenantMembershipMiddleware(): MiddlewareHandler<TenantEnv> {
  return async (c, next) => {
    const user = c.get("user");
    if (!user?.userId) {
      return c.json({ error: "unauthenticated" }, 401);
    }

    const requested =
      c.req.header(TENANT_SELECTOR_HEADER) ?? c.req.query("tenant") ?? "";

    let rows: MembershipRow[];
    try {
      rows = await withClient(c.env, async (client) => {
        const res = await client.query<MembershipRow>(
          `SELECT t.id, t.schema_name, t.subdomain, t.salt, m.role
             FROM public.tenant_memberships m
             JOIN public.tenants t ON t.id = m.tenant_id
            WHERE m.profile_id = $1 AND t.is_active = true
            ORDER BY t.subdomain`,
          [user.userId],
        );
        return res.rows;
      });
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

    if (rows.length === 0) {
      // No membership anywhere. Same answer as the old query gave a user with
      // no profile, so a deprovisioned account is refused exactly as before.
      return c.json({ error: "tenant_not_found" }, 404);
    }

    let selected: MembershipRow | undefined;
    if (requested) {
      selected = rows.find((r) => r.subdomain === requested);
      if (!selected) {
        // Deliberately indistinguishable from "no such tenant". Saying 403 here
        // and 404 for a missing slug would confirm to a stranger whether a
        // given restaurant is on the platform.
        return c.json({ error: "tenant_not_found" }, 404);
      }
    } else if (rows.length === 1) {
      selected = rows[0];
    }

    if (!selected) {
      // Several memberships and no choice made. Refusing is the honest answer;
      // the old `LIMIT 1` answered this silently and arbitrarily.
      return c.json(
        {
          error: "tenant_required",
          available: rows.map((r) => ({
            slug: r.subdomain,
            schemaName: r.schema_name,
            role: r.role,
          })),
        },
        409,
      );
    }

    const { id: tenantId, schema_name: schemaName, subdomain, salt: tenantSalt } =
      selected;

    // Defense-in-depth: the schema name is spliced into SQL downstream, so it
    // is validated against the generated-name pattern before it reaches context.
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

    // Warms the redirect path's cache. This middleware does not read it — the
    // membership decision above is made from Postgres on every request, so a
    // revoked membership takes effect immediately rather than when a TTL ends.
    c.executionCtx.waitUntil(
      setCachedTenant(c.env, subdomain, { schemaName, tenantId, tenantSalt }).catch(
        (err) => {
          console.error(
            JSON.stringify({
              event: "error",
              type: "kv_write_failed",
              message: err instanceof Error ? err.message : String(err),
              tenant: subdomain,
            }),
          );
        },
      ),
    );

    c.set("tenant", {
      tenantSlug: subdomain,
      schemaName,
      tenantId,
      tenantSalt,
      membershipRole: selected.role,
    });

    return await next();
  };
}
