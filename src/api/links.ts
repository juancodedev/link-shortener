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
  client_ref: string | null;
  created_at: string;
}

/** One GROUP BY bucket from the click aggregate, with its row count. */
interface ClickGroupRow {
  country_code: string | null;
  device_type: string | null;
  referrer_source: string | null;
  count: number | string;
}

/** A single recent click as rendered in the dashboard activity list. */
interface RecentClickRow {
  country_code: string | null;
  device_type: string | null;
  referrer: string | null;
  created_at: string;
}

/** How many recent clicks the dashboard activity list shows. */
const RECENT_CLICK_LIMIT = 10;

/** Maximum number of active links per tenant on the free tier. */
const MAX_ACTIVE_LINKS = 30;

/**
 * Maximum length of `client_ref`.
 *
 * `title` is capped at 200 too, but there it is a display label, so silently
 * truncating it is harmless. `client_ref` is an IDENTIFIER the user copies into
 * an external CRM: if we truncated it, the stored value would no longer equal
 * what they typed and the correlation would silently fail to match. So we
 * reject an over-long value instead, and do so on create as well as update
 * (`title` is only capped on update — that gap is pre-existing).
 */
const MAX_CLIENT_REF_LENGTH = 200;

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
  let body: {
    original_url?: string;
    title?: string;
    expires_at?: string;
    client_ref?: string;
  };
  try {
    body = await c.req.json<{
      original_url?: string;
      title?: string;
      expires_at?: string;
      client_ref?: string;
    }>();
  } catch {
    throw new ValidationError("Invalid JSON body", "invalid_request");
  }

  if (!body.original_url || typeof body.original_url !== "string") {
    throw new ValidationError("original_url is required", "invalid_request");
  }

  // client_ref is optional free text the user types to correlate the link with
  // an external CRM record. It is NOT validated against anything — there is no
  // local client entity. Present-but-wrong-type is an error; absent is not, so
  // links created before this column existed keep working.
  if (body.client_ref !== undefined && typeof body.client_ref !== "string") {
    throw new ValidationError("client_ref must be a string", "invalid_request");
  }
  if (typeof body.client_ref === "string" && body.client_ref.length > MAX_CLIENT_REF_LENGTH) {
    throw new ValidationError(
      `client_ref must be at most ${MAX_CLIENT_REF_LENGTH} characters`,
      "invalid_request",
    );
  }

  const { title, expires_at, client_ref } = body;
  let original_url = body.original_url!;

  // --- 2. Validate URL (open-redirect protection) ---
  const urlResult = validateUrl(original_url);
  if (!urlResult.valid) {
    throw new ValidationError(
      `Invalid URL: ${urlResult.error}`,
      urlResult.error ?? "invalid_url",
    );
  }
  // Use normalized URL (with https:// prepended if missing)
  original_url = urlResult.normalized ?? original_url;

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
        `INSERT INTO ${table} (original_url, short_code, title, expires_at, client_ref)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (short_code) DO NOTHING
         RETURNING id, short_code, original_url, title, client_ref, created_at`,
        [original_url, shortCode, title ?? null, expires_at ?? null, client_ref ?? null],
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
    linkId: linkRow.id,
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
      client_ref: linkRow.client_ref ?? null,
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
      `SELECT id, short_code, original_url, title, client_ref, clicks_count, is_active, expires_at, created_at, updated_at
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
      client_ref: r.client_ref ?? null,
      clicks_count: r.clicks_count,
      is_active: r.is_active,
      expires_at: r.expires_at,
      created_at: r.created_at,
      updated_at: r.updated_at,
    })),
  );
};

// ---------------------------------------------------------------------------
// PATCH /api/links/:id — update link (toggle active, change title, set client_ref)
// ---------------------------------------------------------------------------

export const updateLink: Handler<{
  Bindings: AppEnv;
  Variables: HonoVars;
}> = async (c) => {
  const tenant = c.get("tenant");
  const linkId = c.req.param("id")!;

  let body: { is_active?: boolean; title?: string; client_ref?: string };
  try {
    body = await c.req.json();
  } catch {
    throw new ValidationError("Invalid JSON body", "invalid_request");
  }

  // Reject a wrong-typed client_ref up front rather than silently ignoring it:
  // a client that sends `client_ref` and gets `ok: true` would believe the
  // identifier was saved when it was not.
  // `null` is accepted explicitly as "clear the identifier" — the column is
  // nullable and the dashboard needs a way to unset it. Any other non-string
  // (number, object, array, boolean) is a caller bug.
  if (
    body.client_ref !== undefined &&
    body.client_ref !== null &&
    typeof body.client_ref !== "string"
  ) {
    throw new ValidationError("client_ref must be a string or null", "invalid_request");
  }
  if (typeof body.client_ref === "string" && body.client_ref.length > MAX_CLIENT_REF_LENGTH) {
    throw new ValidationError(
      `client_ref must be at most ${MAX_CLIENT_REF_LENGTH} characters`,
      "invalid_request",
    );
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
    // Not sliced — see MAX_CLIENT_REF_LENGTH: a truncated identifier stops
    // matching the CRM record it is meant to point at.
    if (body.client_ref === null) {
      // Explicit clear. Takes no bind param, so it must not consume a slot.
      sets.push(`client_ref = NULL`);
    } else if (typeof body.client_ref === "string") {
      sets.push(`client_ref = $${vals.length + 1}`);
      vals.push(body.client_ref);
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

  const result = await withClient(c.env, async (client) => {
    const table = qualifyTable(tenant.schemaName, "links");
    const linkRes = await client.query<{ id: string }>(
      `SELECT id FROM ${table} WHERE id = $1`, [linkId],
    );
    if (linkRes.rows.length === 0) return null;

    // --- Aggregate across ALL clicks for this link (unbounded) ---
    // One grouped query instead of downloading every click row; the three
    // by_* maps and the total are folded from the buckets below.
    // Try with referrer_source first, fall back if column doesn't exist yet.
    let groups: ClickGroupRow[];
    try {
      const r = await client.query<ClickGroupRow>(
        `SELECT country_code, device_type, referrer_source, COUNT(*)::int AS count
         FROM analytics.link_clicks
         WHERE link_id = $1
         GROUP BY country_code, device_type, referrer_source`,
        [linkId],
      );
      groups = r.rows;
    } catch {
      const r = await client.query<Omit<ClickGroupRow, "referrer_source"> & { referrer_source?: string | null }>(
        `SELECT country_code, device_type, COUNT(*)::int AS count
         FROM analytics.link_clicks
         WHERE link_id = $1
         GROUP BY country_code, device_type`,
        [linkId],
      );
      groups = r.rows.map((row) => ({ ...row, referrer_source: "Direct" as string | null }));
    }

    // --- Recent-N window for the dashboard activity list ---
    // referrer_source is not projected here, so this stays valid whether or
    // not the column exists yet.
    const recentRes = await client.query<RecentClickRow>(
      `SELECT country_code, device_type, referrer, created_at
       FROM analytics.link_clicks
       WHERE link_id = $1
       ORDER BY created_at DESC
       LIMIT ${RECENT_CLICK_LIMIT}`,
      [linkId],
    );

    return { groups, recent: recentRes.rows };
  });

  if (result === null) throw new NotFoundError("Link not found", "not_found");

  const byCountry: Record<string, number> = {};
  const byDevice: Record<string, number> = {};
  const bySource: Record<string, number> = {};
  let total = 0;

  for (const g of result.groups) {
    // COUNT(*)::int already yields a number; Number() keeps the fold correct
    // if a driver returns the count as a string.
    const n = Number(g.count);
    total += n;
    const cc = g.country_code ?? "Unknown";
    byCountry[cc] = (byCountry[cc] || 0) + n;
    const d = g.device_type ?? "Unknown";
    byDevice[d] = (byDevice[d] || 0) + n;
    const s = g.referrer_source ?? "Direct";
    bySource[s] = (bySource[s] || 0) + n;
  }

  return c.json({
    total,
    by_country: byCountry,
    by_device: byDevice,
    by_source: bySource,
    recent: result.recent.map((r) => ({
      country: r.country_code ?? "Unknown",
      device: r.device_type ?? "Unknown",
      referrer: r.referrer ?? "Direct",
      time: r.created_at,
    })),
  });
};
