import type { Handler } from "hono";
import type { AppEnv, HonoVars } from "../types/env";
import { withClient } from "../db/client";
import { qualifyTable } from "../db/schema";
import { validateUrl } from "../utils/validation";
import { generateShortCode } from "../utils/short-code";
import { setCachedUrl, invalidateCachedUrl } from "../cache/shortcode";
import { LimitError, ValidationError, NotFoundError } from "../middleware/error";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface LinkRow {
  id: string;
  short_code: string;
  original_url: string;
  title: string | null;
  created_at: string;
}

/** Maximum number of active links per tenant on the free tier. */
const MAX_ACTIVE_LINKS = 30;

/** Maximum retries for short code collision handling. */
const MAX_RETRIES = 3;

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Handles `POST /api/links` — authenticated link creation.
 *
 * Flow:
 * 1. Read authenticated user from context (auth middleware)
 * 2. Read tenant schema from context (tenant middleware — user-profile-based)
 * 3. Validate `original_url` body param against open-redirect rules
 * 4. Count active links for the tenant; reject if at free-tier limit (30)
 * 5. Generate a 7-char short code via nanoid
 * 6. INSERT with ON CONFLICT DO NOTHING; retry up to 3x on collision
 * 7. Warm KV cache via ctx.waitUntil
 * 8. Return 201 with the created link resource
 *
 * Error middleware wraps this handler — errors thrown here are caught and
 * mapped to appropriate HTTP status codes by the outermost errorHandler.
 */
export const createLink: Handler<{
  Bindings: AppEnv;
  Variables: HonoVars;
}> = async (c) => {
  const env = c.env;
  const tenant = c.get("tenant");

  // --- 1. Parse and validate request body ---
  let body: { original_url?: string; title?: string; expires_at?: string };
  try {
    body = await c.req.json<{
      original_url?: string;
      title?: string;
      expires_at?: string;
    }>();
  } catch {
    throw new ValidationError("Invalid JSON body", "invalid_request");
  }

  if (!body.original_url || typeof body.original_url !== "string") {
    throw new ValidationError("original_url is required", "invalid_request");
  }

  const { original_url, title, expires_at } = body;

  // --- 2. Validate URL (open-redirect protection) ---
  const urlResult = validateUrl(original_url);
  if (!urlResult.valid) {
    throw new ValidationError(
      `Invalid URL: ${urlResult.error}`,
      urlResult.error ?? "invalid_url",
    );
  }

  // --- 3. Count active links (free-tier enforcement) ---
  const countRow = await withClient(env, async (client) => {
    const table = qualifyTable(tenant.schemaName, "links");
    const res = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM ${table} WHERE is_active = true`,
    );
    return res.rows[0];
  });

  const activeCount = countRow ? parseInt(countRow.count, 10) : 0;
  if (activeCount >= MAX_ACTIVE_LINKS) {
    throw new LimitError(
      `Link limit reached (${MAX_ACTIVE_LINKS} active links)`,
      "link_limit_reached",
    );
  }

  // --- 4. Generate short code with collision retry ---
  const now = new Date().toISOString();
  let linkRow: LinkRow | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const shortCode = generateShortCode();

    const rows = await withClient(env, async (client) => {
      const table = qualifyTable(tenant.schemaName, "links");
      const res = await client.query<LinkRow>(
        `INSERT INTO ${table} (original_url, short_code, title, expires_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (short_code) DO NOTHING
         RETURNING id, short_code, original_url, title, created_at`,
        [original_url, shortCode, title ?? null, expires_at ?? null],
      );
      return res.rows;
    });

    if (rows.length > 0) {
      linkRow = rows[0]!;
      break;
    }
    // rowCount 0 → collision; retry
  }

  if (!linkRow) {
    throw new Error("link_creation_failed");
  }

  // --- 5. Warm KV cache (fire-and-forget via waitUntil) ---
  const cachePayload = JSON.stringify({
    url: linkRow.original_url,
    isActive: true,
    expiresAt: expires_at ?? null,
  });

  c.executionCtx.waitUntil(
    setCachedUrl(env, tenant.tenantSlug, linkRow.short_code, cachePayload).catch(
      (err) => {
        console.error(
          JSON.stringify({
            event: "error",
            type: "kv_write_failed",
            message: err instanceof Error ? err.message : String(err),
            tenant: tenant.tenantSlug,
            code: linkRow?.short_code,
          }),
        );
      },
    ),
  );

  // --- 6. Build response ---
  const shortUrl = `https://${env.SHORT_URL_DOMAIN}/r/${tenant.tenantSlug}/${linkRow.short_code}`;

  return c.json(
    {
      id: linkRow.id,
      short_code: linkRow.short_code,
      original_url: linkRow.original_url,
      short_url: shortUrl,
      title: linkRow.title,
      expires_at: expires_at ?? null,
      created_at: linkRow.created_at,
    },
    201,
  );
};

// ---------------------------------------------------------------------------
// GET /api/links — list user's links
// ---------------------------------------------------------------------------

export const listLinks: Handler<{
  Bindings: AppEnv;
  Variables: HonoVars;
}> = async (c) => {
  const tenant = c.get("tenant");

  const rows = await withClient(c.env, async (client) => {
    const table = qualifyTable(tenant.schemaName, "links");
    const res = await client.query<LinkRow & { clicks_count: number; is_active: boolean; expires_at: string | null; updated_at: string }>(
      `SELECT id, short_code, original_url, title, clicks_count, is_active, expires_at, created_at, updated_at
       FROM ${table}
       ORDER BY created_at DESC
       LIMIT 100`,
    );
    return res.rows;
  });

  const domain = `https://${c.env.SHORT_URL_DOMAIN}/r/${tenant.tenantSlug}`;

  return c.json(
    rows.map((r) => ({
      id: r.id,
      short_code: r.short_code,
      original_url: r.original_url,
      short_url: `${domain}/${r.short_code}`,
      title: r.title,
      clicks_count: r.clicks_count,
      is_active: r.is_active,
      expires_at: r.expires_at,
      created_at: r.created_at,
      updated_at: r.updated_at,
    })),
  );
};

// ---------------------------------------------------------------------------
// PATCH /api/links/:id — update link (toggle active, change title)
// ---------------------------------------------------------------------------

export const updateLink: Handler<{
  Bindings: AppEnv;
  Variables: HonoVars;
}> = async (c) => {
  const tenant = c.get("tenant");
  const linkId = c.req.param("id")!;

  let body: { is_active?: boolean; title?: string };
  try {
    body = await c.req.json();
  } catch {
    throw new ValidationError("Invalid JSON body", "invalid_request");
  }

  const rows = await withClient(c.env, async (client) => {
    const table = qualifyTable(tenant.schemaName, "links");
    const sets: string[] = [];
    const vals: (string | boolean)[] = [];

    if (typeof body.is_active === "boolean") {
      sets.push(`is_active = $${vals.length + 1}`);
      vals.push(body.is_active);
    }
    if (typeof body.title === "string") {
      sets.push(`title = $${vals.length + 1}`);
      vals.push(body.title.slice(0, 200));
    }

    if (sets.length === 0) {
      throw new ValidationError("No fields to update", "invalid_request");
    }

    sets.push(`updated_at = NOW()`);
    vals.push(linkId);

    const res = await client.query<{ short_code: string; is_active: boolean }>(
      `UPDATE ${table} SET ${sets.join(", ")} WHERE id = $${vals.length} RETURNING short_code, is_active`,
      vals,
    );
    return res.rows;
  });

  if (rows.length === 0) throw new NotFoundError("Link not found", "not_found");

  // Invalidate KV cache on status change
  if (typeof body.is_active === "boolean") {
    c.executionCtx.waitUntil(
      invalidateCachedUrl(c.env, tenant.tenantSlug, rows[0]!.short_code).catch(() => {}),
    );
  }

  return c.json({ ok: true });
};

// ---------------------------------------------------------------------------
// DELETE /api/links/:id — delete a link
// ---------------------------------------------------------------------------

export const deleteLink: Handler<{
  Bindings: AppEnv;
  Variables: HonoVars;
}> = async (c) => {
  const tenant = c.get("tenant");
  const linkId = c.req.param("id")!;

  const rows = await withClient(c.env, async (client) => {
    const table = qualifyTable(tenant.schemaName, "links");
    const res = await client.query<{ short_code: string }>(
      `DELETE FROM ${table} WHERE id = $1 RETURNING short_code`,
      [linkId],
    );
    return res.rows;
  });

  if (rows.length === 0) throw new NotFoundError("Link not found", "not_found");

  // Invalidate KV cache
  c.executionCtx.waitUntil(
    invalidateCachedUrl(c.env, tenant.tenantSlug, rows[0]!.short_code).catch(() => {}),
  );

  return c.json({ ok: true });
};

// ---------------------------------------------------------------------------
// GET /api/links/:id/clicks — click analytics for a specific link
// ---------------------------------------------------------------------------

export const linkClicks: Handler<{
  Bindings: AppEnv;
  Variables: HonoVars;
}> = async (c) => {
  const tenant = c.get("tenant");
  const linkId = c.req.param("id")!;

  const rows = await withClient(c.env, async (client) => {
    const table = qualifyTable(tenant.schemaName, "links");
    const linkRes = await client.query<{ id: string }>(
      `SELECT id FROM ${table} WHERE id = $1`, [linkId],
    );
    if (linkRes.rows.length === 0) return null;

    const res = await client.query<{
      country_code: string | null;
      device_type: string | null;
      referrer: string | null;
      created_at: string;
    }>(
      `SELECT country_code, device_type, referrer, created_at
       FROM analytics.link_clicks
       WHERE link_id = $1
       ORDER BY created_at DESC
       LIMIT 50`,
      [linkId],
    );
    return res.rows;
  });

  if (rows === null) throw new NotFoundError("Link not found", "not_found");

  const byCountry: Record<string, number> = {};
  const byDevice: Record<string, number> = {};

  for (const r of rows) {
    const c = r.country_code ?? "Unknown";
    byCountry[c] = (byCountry[c] || 0) + 1;
    const d = r.device_type ?? "Unknown";
    byDevice[d] = (byDevice[d] || 0) + 1;
  }

  return c.json({
    total: rows.length,
    by_country: byCountry,
    by_device: byDevice,
    recent: rows.slice(0, 10).map((r) => ({
      country: r.country_code ?? "Unknown",
      device: r.device_type ?? "Unknown",
      referrer: r.referrer ?? "Direct",
      time: r.created_at,
    })),
  });
};
