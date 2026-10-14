import type { Handler } from "hono";
import type { AppEnv, HonoVars } from "../types/env";
import { withClient } from "../db/client";
import { qualifyTable } from "../db/schema";
import { setCachedUrl, getCachedUrl } from "../cache/shortcode";
import { resolveRegistryEntry } from "../api/links";
import { trackClick } from "../analytics/tracker";
import { renderActionScreen, escapeHtml } from "./action-screen";

// ---------------------------------------------------------------------------
// Types for KV-cached link metadata
// ---------------------------------------------------------------------------

/** Shape of the JSON blob stored in KV for a cached short code entry. */
interface CachedLink {
  url: string;
  isActive: boolean;
  expiresAt: string | null;
  linkId: string;
  /**
   * Whether a scan renders the action screen instead of redirecting.
   *
   * Optional because KV entries outlive a deploy: a blob written before this
   * field existed has no such key, and reading `undefined` must mean `false`.
   * A gated default here would replace every live redirect with an
   * interstitial the day the change shipped.
   */
  isGated?: boolean;
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

  const { schemaName, tenantId, tenantSalt, subdomain, displayName } = entry;
  const slug = subdomain;

  // --- 1b. Subscription pause ---
  //
  // Checked HERE, before the short-URL cache is consulted, because the Google
  // URL lives in `{slug}:{code}`, not in the registry entry. Gating after the
  // cache lookup would let the pause be bypassed by a warm cache — and a warm
  // cache is exactly the state a printed sticker is in most of the time.
  //
  // It is also the first place this runs, so a paused tenant costs no query.
  //
  // A paused tenant is NOT a missing tenant. `is_active = false` already
  // produces a 404 above; this returns 402 with a way back, because the business
  // exists and the customer is being asked to settle an invoice.
  if (isSubscriptionPaused(entry.subscriptionStatus)) {
    return new Response(
      renderSubscriptionPaused(slug, displayName ?? slug, c.env.BILLING_CONTACT),
      {
        status: 402,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          // A paused sticker must not be cached by anything in between: serving
          // a paused page from a CDN would outlive the pause by an unknown
          // amount.
          "Cache-Control": "no-store",
          "X-Robots-Tag": "noindex, nofollow",
        },
      },
    );
  }

  // --- 2. KV cache lookup ---
  let cacheHit = false;
  let redirectUrl: string | null = null;
  // Defaults to false so every pre-deploy code path that never learns about
  // gating keeps its plain 302. Only an explicit true opens the screen.
  let isGated = false;
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
        isGated = parsed.isGated === true;
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
          SELECT id, original_url, is_active, expires_at, is_gated
          FROM ${table}
          WHERE short_code = $1
          LIMIT 1
        `;
        const res = await client.query<{
          id: string;
          original_url: string;
          is_active: boolean;
          expires_at: string | null;
          is_gated: boolean | null;
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
      isGated = row.is_gated === true;

      // --- 4. Populate KV cache (fire-and-forget via waitUntil) ---
      const cacheValue: CachedLink = {
        url: row.original_url,
        isActive: row.is_active,
        expiresAt: row.expires_at,
        linkId: row.id,
        isGated: row.is_gated === true,
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

  // --- 6. Gated links render the action screen instead of redirecting ---
  //
  // The whole branch is wrapped: a throw anywhere in rendering must fall
  // through to the plain 302 below. A sticker is printed once and lives in the
  // world for months, and a bug in this new UI must never be able to take one
  // down. The always-functional contract, in code.
  if (isGated) {
    try {
      return renderActionScreen({
        businessName: displayName || slug,
        destinationUrl: redirectUrl!,
        code,
      });
    } catch (err) {
      console.error(
        JSON.stringify({
          event: "error",
          type: "action_screen_failed",
          message: err instanceof Error ? err.message : String(err),
          tenant: slug,
          code,
        }),
      );
    }
  }

  return c.redirect(redirectUrl!, 302);
};

/**
 * Whether a tenant's billing state should stop its links from resolving.
 *
 * A missing status means "assume active". That is the pre-subscription
 * behaviour and is the only safe reading: a cache entry written before the
 * field existed has no such key, and failing closed there would 404 a live
 * business over an absent JSON property.
 */
export function isSubscriptionPaused(status: string | undefined): boolean {
  return status === "past_due" || status === "canceled";
}

/**
 * Shown when a tenant's subscription has lapsed.
 *
 * It must not accuse: most often this is an invoice the owner has not seen, not
 * a customer in arrears, and the person reading it at the table is a diner who
 * did nothing wrong. Hence "ask the business to settle it" and no blame, no
 * judgement, and no implication that the local is closed — it is not.
 */
export function renderSubscriptionPaused(
  slug: string,
  businessName: string,
  billingContact?: string,
): string {
  const name = escapeHtml(businessName);
  const reactivate = renderReactivate(escapeHtml(slug), billingContact);
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${name}</title>
<style>
  body { font-family: system-ui, -apple-system, sans-serif; margin: 0; padding: 2rem 1.25rem;
         background: #f6f6f4; color: #1a1a1a; }
  main { max-width: 30rem; margin: 0 auto; background: #fff; border: 1px solid #e5e5e0;
         border-radius: 12px; padding: 1.75rem; }
  h1 { font-size: 1.15rem; margin: 0 0 .75rem; }
  p { font-size: .95rem; line-height: 1.55; margin: 0 0 .75rem; color: #3d3d3d; }
  code { font-family: ui-monospace, monospace; font-size: .85rem; background: #f0f0ec;
         padding: .1rem .35rem; border-radius: 4px; }
</style>
</head>
<body>
<main>
  h1 { font-size: 1.15rem; margin: 0 0 .75rem; }
  p { font-size: .95rem; line-height: 1.55; margin: 0 0 .75rem; color: #3d3d3d; }
  a.reactivate { display: inline-block; margin-top: .25rem; padding: .7rem 1.1rem;
                 background: #1a1a1a; color: #fff; border-radius: 8px;
                 text-decoration: none; font-size: .95rem; }
  small { display: block; margin-top: 1.25rem; padding-top: 1rem;
         border-top: 1px solid #e5e5e0; font-size: .85rem; color: #6b6b6b; }
</style>
</head>
<body>
<main>
  <h1>${name}</h1>
  <p>Este punto está pausado temporalmente y no puede recibir comentarios ni reseñas por ahora.</p>
  <p>El local está abierto: si necesitás algo, pedí ayuda en el mostrador.</p>
  ${reactivate}
</main>
</body>
</html>`;
}

/**
 * The way out of a pause.
 *
 * Two audiences share this page and the copy has to serve both without
 * confusing either. The person who scanned the sticker is a diner who did
 * nothing wrong and should never be told they owe something. The person who
 * needs to act is the owner, who finds this page by checking their own sticker.
 *
 * So the diner's line comes first and says plainly that the business is open,
 * and the reactivation path is separated under a rule and addressed to the
 * owner. Neither is presented as the other.
 *
 * The link is deliberately NOT a checkout. Billing is off-platform, and a
 * button that changed the subscription itself would defeat the reason `/api/ops`
 * refuses every customer credential: `active` is exactly what a non-paying
 * customer would grant themselves.
 */
function renderReactivate(slug: string, contact?: string): string {
  const href = safeContactHref(contact);
  const action = href
    ? `<a class="reactivate" href="${href}">Reactivar este punto</a>`
    : `<p>Si sos el due&ntilde;o de este negocio, contactanos para reactivarlo.</p>`;

  return `<small>
  <p style="margin:0 0 .75rem">&iquest;Sos el due&ntilde;o de este negocio? ${action}</p>
</small>`;
}

/**
 * Accepts only the schemes a support address legitimately uses.
 *
 * `BILLING_CONTACT` is operator configuration rather than user input, but it
 * lands inside an `href`, and a value like `javascript:...` there would be
 * script execution on a page a customer is already visiting. Anything that is
 * not a plain address, a `mailto:`, or an http(s) URL is discarded, and the
 * page falls back to showing the instructions without a link.
 */
function safeContactHref(contact?: string): string | null {
  if (!contact) return null;
  const value = contact.trim();
  if (/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(value)) {
    return `mailto:${value}`;
  }
  if (/^https?:\/\/[A-Za-z0-9.-]+(?:\/[^\s]*)?$/i.test(value)) {
    return value;
  }
  return null;
}
