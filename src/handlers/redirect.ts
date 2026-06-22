import type { Handler } from "hono";
import type { AppEnv, HonoVars } from "../types/env";
import { withClient } from "../db/client";
import { validateSchemaName, qualifyTable } from "../db/schema";
import { getCachedUrl } from "../cache/shortcode";
import { getCachedSchema, setCachedSchema } from "../cache/tenant";
import { trackClick } from "../analytics/tracker";

// ---------------------------------------------------------------------------
// Types for KV-cached link metadata
// ---------------------------------------------------------------------------

/** Shape of the JSON blob stored in KV for a cached short code entry. */
interface CachedLink {
  url: string;
  isActive: boolean;
  expiresAt: string | null; // ISO 8601 timestamp or null
}

// ---------------------------------------------------------------------------
// Tenant resolution (inline, not via middleware)
// ---------------------------------------------------------------------------

interface ResolvedTenant {
  tenantId: string;
  schemaName: string;
  tenantSalt: string;
}

/**
 * Resolves a tenant slug to its database schema name.
 * Checks KV cache first; on miss, queries `public.tenants` via Hyperdrive
 * and populates the cache asynchronously.
 *
 * @returns Resolved tenant info, or null if the tenant is not found.
 * @throws On database connection failures.
 */
async function resolveTenant(
  env: AppEnv,
  slug: string,
): Promise<ResolvedTenant | null> {
  // 1. Try KV cache
  const cachedSchema = await getCachedSchema(env, slug);
  if (cachedSchema !== null) {
    try {
      validateSchemaName(cachedSchema);
      // tenantId not available from KV-only path; we set "" and handlers
      // that need it can query DB. For redirect, tenantId comes from the
      // link row query or a separate tenant query.
      return { tenantId: "", schemaName: cachedSchema, tenantSalt: "" };
    } catch {
      // Invalid cached value — fall through to DB
    }
  }

  // 2. Cache miss — query public.tenants via Hyperdrive
  const rows = await withClient(env, async (client) => {
    const res = await client.query<{ id: string; schema_name: string; salt: string }>(
      `SELECT id, schema_name, salt FROM public.tenants WHERE subdomain = $1 AND is_active = true LIMIT 1`,
      [slug],
    );
    return res.rows;
  });

  if (rows.length === 0) {
    return null;
  }

  const { id: tenantId, schema_name: schemaName, salt: tenantSalt } = rows[0]!;
  validateSchemaName(schemaName); // Defense-in-depth — throws on invalid

  // 3. Populate KV cache asynchronously (not awaited — non-critical path)
  // We don't have executionCtx here (this runs before response), so await directly.
  // The cache write is fast and takes <1ms.
  await setCachedSchema(env, slug, schemaName).catch(() => {
    // KV write failure is non-fatal — we already have the schema
  });

  return { tenantId, schemaName, tenantSalt };
}

// ---------------------------------------------------------------------------
// Redirect handler
// ---------------------------------------------------------------------------

/**
 * Handles `GET /r/:tenant/:code`.
 *
 * Flow:
 * 1. Extract tenant slug + short code from URL path params
 * 2. Resolve tenant → schema name (KV → Hyperdrive fallback)
 * 3. Look up short code in KV cache (24h TTL)
 * 4. KV hit → validate isActive/expiresAt from JSON blob → 301 or 410
 * 5. KV miss → query `{schema}.links` via Hyperdrive → 301 (cache) or 404/410
 * 6. On 301 → fire-and-forget click tracking via ctx.waitUntil
 *
 * Never destructures `ctx` — uses `c.executionCtx.waitUntil()` directly.
 */
export const redirectHandler: Handler<{
  Bindings: AppEnv;
  Variables: HonoVars;
}> = async (c) => {
  const startTime = Date.now();

  // Extract params
  const slug = c.req.param("tenant") ?? "";
  const code = c.req.param("code") ?? "";

  if (!slug || !code) {
    return c.json({ error: "not_found" }, 404);
  }

  const env = c.env;

  // --- 1. Resolve tenant ---
  let tenant: ResolvedTenant | null;
  try {
    tenant = await resolveTenant(env, slug);
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "error",
        type: "db_query_failed",
        message: err instanceof Error ? err.message : String(err),
        tenant: slug,
        code,
      }),
    );
    return c.json({ error: "service_unavailable" }, 503);
  }

  if (!tenant) {
    return c.json({ error: "tenant_not_found" }, 404);
  }

  const { schemaName, tenantId, tenantSalt } = tenant;

  // --- 2. KV cache lookup ---
  let cacheHit = false;
  let redirectUrl: string | null = null;
  let linkId = "";

  try {
    const cached = await getCachedUrl(env, slug, code);

    if (cached !== null) {
      cacheHit = true;

      // Try parsing as JSON blob (new format with metadata)
      try {
        const parsed: CachedLink = JSON.parse(cached);
        if (!parsed.isActive) {
          return c.json({ error: "link_inactive" }, 410);
        }
        if (parsed.expiresAt && new Date(parsed.expiresAt) < new Date()) {
          return c.json({ error: "link_expired" }, 410);
        }
        redirectUrl = parsed.url;
      } catch {
        // Legacy plain-URL format — treat as active with no expiry
        redirectUrl = cached;
      }
    }
  } catch {
    // KV error — graceful degradation to DB query
  }

  // --- 3. Database fallback (cache miss) ---
  if (!cacheHit || redirectUrl === null) {
    try {
      const rows = await withClient(env, async (client) => {
        const table = qualifyTable(schemaName, "links");
        const query = `
          SELECT id, original_url, is_active, expires_at
          FROM ${table}
          WHERE short_code = $1
          LIMIT 1
        `;
        const res = await client.query<{
          id: string;
          original_url: string;
          is_active: boolean;
          expires_at: string | null;
        }>(query, [code]);
        return res.rows;
      });

      if (rows.length === 0) {
        return c.json({ error: "not_found" }, 404);
      }

      const row = rows[0]!;
      linkId = row.id;

      // Evaluate lifecycle
      if (!row.is_active) {
        return c.json({ error: "link_inactive" }, 410);
      }
      if (row.expires_at && new Date(row.expires_at) < new Date()) {
        return c.json({ error: "link_expired" }, 410);
      }

      redirectUrl = row.original_url;

      // --- 4. Populate KV cache (fire-and-forget via waitUntil) ---
      const cacheValue: CachedLink = {
        url: row.original_url,
        isActive: row.is_active,
        expiresAt: row.expires_at,
      };

      c.executionCtx.waitUntil(
        (async () => {
          try {
            await env.SHORT_URL_CACHE.put(`${slug}:${code}`, JSON.stringify(cacheValue), {
              expirationTtl: 86400,
            });
          } catch (err) {
            console.error(
              JSON.stringify({
                event: "error",
                type: "kv_write_failed",
                message: err instanceof Error ? err.message : String(err),
                tenant: slug,
                code,
              }),
            );
          }
        })(),
      );
    } catch (err) {
      console.error(
        JSON.stringify({
          event: "error",
          type: "db_query_failed",
          message: err instanceof Error ? err.message : String(err),
          tenant: slug,
          code,
        }),
      );
      return c.json({ error: "service_unavailable" }, 503);
    }
  }

  // --- 5. Redirect ---
  const durationMs = Date.now() - startTime;

  // Structured redirect log (REQ-O001)
  console.log(
    JSON.stringify({
      event: "redirect",
      code,
      tenant: slug,
      cacheHit,
      durationMs,
      status: 301,
    }),
  );

  // Fire-and-forget click tracking (REQ-A001)
  // NEVER destructure ctx — use c.executionCtx.waitUntil directly
  c.executionCtx.waitUntil(
    trackClick(env, {
      tenantId: tenantId || "",
      schemaName,
      linkId,
      shortCode: code,
      request: c.req.raw,
      tenantSalt: tenantSalt || "",
    }).catch((err) => {
      // trackClick catches internally, but belt-and-suspenders
      console.error(
        JSON.stringify({
          event: "error",
          type: "track_click_uncaught",
          message: err instanceof Error ? err.message : String(err),
          tenant: slug,
          code,
        }),
      );
    }),
  );

  return c.redirect(redirectUrl!, 301);
};
