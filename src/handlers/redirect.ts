import type { Handler } from "hono";
import type { AppEnv, HonoVars } from "../types/env";
import { withClient } from "../db/client";
import { qualifyTable } from "../db/schema";
import { setCachedUrl, getCachedUrl } from "../cache/shortcode";
import { resolveRegistryEntry } from "../api/links";
import { trackClick } from "../analytics/tracker";

// ---------------------------------------------------------------------------
// Types for KV-cached link metadata
// ---------------------------------------------------------------------------

/** Shape of the JSON blob stored in KV for a cached short code entry. */
interface CachedLink {
  url: string;
  isActive: boolean;
  expiresAt: string | null;
  linkId: string;
}

// ---------------------------------------------------------------------------
// Redirect handler
// ---------------------------------------------------------------------------

/**
 * Handles `GET /:code` — the flat public short link.
 *
 * Flow:
 * 1. Read the short code from the single path parameter
 * 2. Resolve the owning tenant through `public.short_code_registry`
 *    (registry KV → registry join → warm cache)
 * 3. A registry miss is a 404 — no tenant schema is touched, and no other
 *    schema is tried
 * 4. Look up the link in the short-URL KV cache (24h TTL)
 * 5. KV hit → validate isActive/expiresAt from JSON blob → 302 or 410
 * 6. KV miss → query `{schema}.links` → 302 (cache) or 404/410
 * 7. On 302 → fire-and-forget click tracking via ctx.waitUntil
 *
 * The tenant used to come from the URL (`/r/:tenant/:code`) and was the
 * isolation boundary. It now comes from the registry, which is why step 2 must
 * happen before step 6 can build a schema-qualified table name.
 *
 * Never destructures `ctx` — uses `c.executionCtx.waitUntil()` directly.
 */
export const redirectHandler: Handler<{
  Bindings: AppEnv;
  Variables: HonoVars;
}> = async (c) => {
  const startTime = Date.now();

  const code = c.req.param("code") ?? "";

  if (!code) {
    return c.json({ error: "not_found" }, 404);
  }

  const env = c.env;

  // --- 1. Resolve the tenant that owns this short code ---
  let entry: Awaited<ReturnType<typeof resolveRegistryEntry>> = null;
  try {
    entry = await resolveRegistryEntry(env, code);
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "error",
        type: "registry_query_failed",
        message: err instanceof Error ? err.message : String(err),
        code,
      }),
    );
    return c.json({ error: "service_unavailable" }, 503);
  }

  if (!entry) {
    return c.json({ error: "not_found" }, 404);
  }

  const { schemaName, tenantId, tenantSalt, subdomain } = entry;
  const slug = subdomain;

  // --- 2. KV cache lookup ---
  let cacheHit = false;
  let redirectUrl: string | null = null;
  // Prefer the registry's link id: it is the value the registry was written with
  // and it saves a round trip when the short-URL entry is cold.
  let linkId = entry.linkId ?? "";

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
        linkId = parsed.linkId || "";
        // Cache missing linkId (old format) — force DB refresh
        if (!parsed.linkId) cacheHit = false;
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
        linkId: row.id,
      };

      c.executionCtx.waitUntil(
        setCachedUrl(env, slug, code, JSON.stringify(cacheValue)),
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
      status: 302,
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

  return c.redirect(redirectUrl!, 302);
};
