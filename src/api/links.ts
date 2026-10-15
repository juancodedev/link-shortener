import type { Handler } from "hono";
import type { AppEnv, HonoVars, TenantContext } from "../types/env";
import { withClient } from "../db/client";
import { qualifyTable, validateSchemaName } from "../db/schema";
import { validateUrl } from "../utils/validation";
import { generateShortCode, validateCustomSlug } from "../utils/short-code";
import {
  UNIQUE_WINDOW,
  SESSION_WINDOW,
  buildLinkVisitorMetricsQuery,
  toCount,
  type VisitorMetricsRow,
} from "../analytics/metrics";
import {
  setCachedUrl,
  invalidateCachedUrl,
  getCachedRegistryEntry,
  setCachedRegistryEntry,
  invalidateCachedRegistryEntry,
} from "../cache/shortcode";
import { LimitError, ValidationError, NotFoundError, ConflictError } from "../middleware/error";

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

/**
 * Fallback active-link cap when `MAX_ACTIVE_LINKS` is not configured (T3.1).
 *
 * This was `30`, a hardcoded free-tier number that blocked the actual
 * deployment: one NFC tag or QR sticker per physical location. A chain of forty
 * locations could not onboard at all, and a tenant paying for the service could
 * not change a constant buried inside a handler.
 *
 * The guard itself is kept — a runaway-creation backstop is worth having — but
 * the number is now operator configuration, and this is only what a deployment
 * that has not configured one gets.
 *
 * Generous on purpose. There is one link per store in the target deployment, and
 * a chain can be hundreds of locations; a cap that trips in normal use is a cap
 * that gets raised under pressure, by whoever is under pressure.
 */
export const DEFAULT_MAX_ACTIVE_LINKS = 1000;

/**
 * Resolves the active-link cap from the environment (T3.1).
 *
 * Every malformed value falls back to the default rather than being coerced. A
 * typo in a wrangler var must never read as `0` and lock every tenant out of
 * creating anything — a silent denial of service that looks like a working
 * guard. `12abc` is not "12", `-5` is not a cap, and `0` blocks all creation.
 *
 * Accepts only a bare non-negative integer string. Anything else is a
 * configuration mistake, and the safe response to a configuration mistake is
 * the documented default, not a guess.
 */
export function resolveMaxActiveLinks(
  env: Pick<AppEnv, "MAX_ACTIVE_LINKS">,
): number {
  const raw = env.MAX_ACTIVE_LINKS;
  if (typeof raw !== "string") return DEFAULT_MAX_ACTIVE_LINKS;

  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return DEFAULT_MAX_ACTIVE_LINKS;

  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_MAX_ACTIVE_LINKS;

  return parsed;
}

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

/**
 * Maximum retries when GENERATING a short code (D1).
 *
 * Applies to generated codes ONLY. A caller-supplied slug gets exactly one
 * attempt — see `createLinkCore`. This bound is deliberately not shared with the
 * supplied-slug path, and the two must never be unified: retrying a supplied
 * slug means drawing a DIFFERENT code, which is precisely the silent
 * substitution that would break stickers already printed and in the world.
 */
const MAX_RETRIES = 3;

// ---------------------------------------------------------------------------
// Short-code registry (public.short_code_registry)
//
// Public links are flat: `https://<domain>/<code>`. The tenant slug that used to
// sit in the path WAS the isolation boundary — it selected the schema, and the
// link query ran inside it. With the slug gone, nothing maps a bare code back to
// a tenant, so the registry is the resolution step that replaces it.
//
// Consequence worth stating plainly: no tenant schema may be read before this
// table has answered. A registry miss is a 404, not a "try every schema".
//
// The read and the writes both live here rather than in the redirect handler so
// there is one module that owns the table's shape. See
// `supabase/migrations/00005_short_code_registry.sql`.
// ---------------------------------------------------------------------------

/** Everything a redirect needs after resolving a short code to its tenant. */
export interface ResolvedRegistryEntry {
  tenantId: string;
  schemaName: string;
  tenantSalt: string;
  subdomain: string;
  linkId: string | null;
  /**
   * Human-readable business name, used as the action screen's heading.
   *
   * Optional because a KV entry written before this field existed has no such
   * key, and the redirect falls back to the subdomain rather than rendering a
   * blank title.
   */
  displayName?: string;
  /**
   * Billing state of the owning tenant, as of when this entry was written.
   *
   * This is a MIRROR of `public.tenants.subscription_status`, not the truth. The
   * registry cache has a 24 h TTL, so this value goes stale: when it expires the
   * JOIN re-reads the real status and the entry is rewritten. That is the
   * property that keeps a paused tenant from resurrecting itself.
   *
   * Optional because a cache entry written before this field existed has no such
   * key. A missing value means "assume active" — the pre-subscription behaviour,
   * and the safe direction only for as long as it stays true.
   */
  subscriptionStatus?: string;
}

/**
 * Turns a bare short code into the tenant that owns it.
 *
 * Order: KV cache → registry join → warm cache.
 *
 * The join is against `public.tenants` rather than reading the registry alone
 * because the caller needs `schema_name`, `salt`, and `subdomain`, and all three
 * come from the tenant row. The `is_active` predicate means a deactivated tenant
 * resolves to a miss rather than to a schema that should no longer serve.
 *
 * @returns The resolved entry, or null when the code is unknown or its tenant
 *          is not active.
 * @throws On database failure, or on a registry row whose schema_name fails
 *         validateSchemaName — the caller turns both into a 503.
 */
export async function resolveRegistryEntry(
  env: AppEnv,
  shortCode: string,
): Promise<ResolvedRegistryEntry | null> {
  const cached = await getCachedRegistryEntry(env, shortCode);
  if (cached !== null) {
    // Throws on a poisoned cache value, same as on a poisoned row.
    validateSchemaName(cached.schemaName);
    return cached;
  }

  const rows = await withClient(env, async (client) => {
    const res = await client.query<{
      short_code: string;
      link_id: string | null;
      tenant_id: string;
      schema_name: string;
      salt: string;
      subdomain: string;
      display_name: string;
      subscription_status: string;
    }>(
      `SELECT r.short_code,
              r.link_id,
              t.id           AS tenant_id,
              t.schema_name,
              t.salt,
              t.subdomain,
              t.display_name,
              t.subscription_status
         FROM public.short_code_registry r
         JOIN public.tenants t ON t.id = r.tenant_id
        WHERE r.short_code = $1
          AND t.is_active = true
        LIMIT 1`,
      [shortCode],
    );
    return res.rows;
  });

  if (rows.length === 0) return null;

  const row = rows[0]!;
  // schema_name is interpolated into SQL downstream, so it is validated here at
  // the boundary rather than at each use.
  validateSchemaName(row.schema_name);

  const entry: ResolvedRegistryEntry = {
    tenantId: row.tenant_id,
    schemaName: row.schema_name,
    tenantSalt: row.salt,
    subdomain: row.subdomain,
    linkId: row.link_id,
    displayName: row.display_name,
    subscriptionStatus: row.subscription_status,
  };

  await setCachedRegistryEntry(env, shortCode, entry);

  return entry;
}

/**
 * Removes a short code from the registry.
 *
 * Called from deleteLink. Tenant removal does NOT come through here — that is
 * covered by `ON DELETE CASCADE` and handled in `deprovision.ts`, where the
 * removed codes are also returned for KV invalidation.
 */
async function deleteRegistryRow(env: AppEnv, shortCode: string): Promise<void> {
  await withClient(env, async (client) => {
    await client.query(
      `DELETE FROM public.short_code_registry WHERE short_code = $1`,
      [shortCode],
    );
  });
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * The created-link resource, exactly as `POST /api/links` returns it.
 *
 * Named and exported because `POST /api/links/batch` returns the SAME shape per
 * item. Batch items are not a second dialect of "a link" — a caller comparing a
 * batch result with a single-create result must find them identical.
 */
export interface CreatedLinkResource {
  id: string;
  short_code: string;
  /** `null` when the link is card stock: created, printed, destination not loaded yet. */
  original_url: string | null;
  short_url: string;
  title: string | null;
  expires_at: string | null;
  client_ref: string | null;
  created_at: string;
}

/** A validated request to create one link. */
export interface CreateLinkInput {
  /**
   * Optional. Omit it to create card stock — a link that exists, is active and
   * is ready to print, but has nowhere to forward a customer yet.
   *
   * A value that IS supplied is validated exactly as before. This makes the
   * field optional, never unchecked.
   */
  original_url?: string;
  title?: string;
  expires_at?: string;
  client_ref?: string;
  /** Optional caller-chosen slug — for pre-printed tags. See D1/D2. */
  slug?: string;
}

/** Everything `createLinkCore` needs that a Hono context would otherwise supply. */
export interface CreateLinkCoreArgs {
  env: AppEnv;
  tenant: TenantContext;
  /**
   * Fire-and-forget sink for cache warming.
   *
   * Passed in rather than reaching for `c.executionCtx` so the batch handler can
   * reuse this function without fabricating a Hono context per item.
   */
  waitUntil: (promise: Promise<unknown>) => void;
  input: CreateLinkInput;
}

/**
 * Validates and creates one link, or throws an `AppError`.
 *
 * Extracted from the `POST /api/links` handler so `POST /api/links/batch`
 * creates items through the EXACT same path. Batching that re-implemented
 * validation would be free to drift from single creation — the two would then
 * disagree about what a valid slug or URL is, and a link creatable one way but
 * not the other is a bug nobody would think to look for.
 *
 * Errors thrown here are `AppError` subclasses, so a caller can either let the
 * global `errorHandler` map them (single create) or map them per item
 * (batch). Both consume the same values.
 *
 * @throws ValidationError | LimitError | ConflictError — all 4xx, all safe to
 *         show a user. Anything else is a genuine fault and propagates.
 */
export async function createLinkCore({
  env,
  tenant,
  waitUntil,
  input,
}: CreateLinkCoreArgs): Promise<CreatedLinkResource> {
  const { title, expires_at, client_ref } = input;

  // --- 0. The payload itself must be a link ---
  //
  // Placed before every field check because `original_url` becoming optional
  // removed the check that was implicitly rejecting garbage. A batch item of
  // "not-an-object" used to fail because it had no `original_url`; with the
  // field optional it would quietly become card stock, and an import script
  // would report success for a row nobody described.
  //
  // `null` and `[]` are rejected here too. `(item ?? {})` in the batch path
  // turns an explicit null into `{}`, which IS a valid card-stock request, so
  // the guard has to be on the shape rather than on a missing key.
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new ValidationError("link must be an object", "invalid_request");
  }

  // --- 1. original_url is optional ---
  //
  // ABSENT means card stock: a link that exists, is active, and is ready to
  // print, with nowhere to forward a customer yet. That is a real state, not a
  // caller mistake — the owner creates the batch, the designer prints the QR,
  // and the destination is loaded later.
  //
  // Present-but-wrong-type is still an error. Silently reading `12345` as
  // "absent" would create a link whose destination nobody ever typed, and the
  // owner would only find out when a customer scans the card.
  //
  // The length bound is deliberately not duplicated here. An absent URL has no
  // length, and a supplied one is bounded by validateUrl below.
  if (
    input.original_url !== undefined &&
    input.original_url !== null &&
    typeof input.original_url !== "string"
  ) {
    throw new ValidationError("original_url must be a string", "invalid_request");
  }
  if (typeof input.original_url === "string" && input.original_url === "") {
    // Empty string is how an HTML form posts a blank required field. Treating
    // it as absent is what lets the dashboard create card stock without a
    // second dialect for "blank"; treating it as a URL would send validateUrl
    // a relative path and reject a legitimate request.
    input = { ...input, original_url: undefined };
  }

  // client_ref is optional free text the user types to correlate the link with
  // an external CRM record. It is NOT validated against anything — there is no
  // local client entity. Present-but-wrong-type is an error; absent is not, so
  // links created before this column existed keep working.
  if (client_ref !== undefined && typeof client_ref !== "string") {
    throw new ValidationError("client_ref must be a string", "invalid_request");
  }
  if (typeof client_ref === "string" && client_ref.length > MAX_CLIENT_REF_LENGTH) {
    throw new ValidationError(
      `client_ref must be at most ${MAX_CLIENT_REF_LENGTH} characters`,
      "invalid_request",
    );
  }

  // --- 2. Caller-supplied slug (D2), validated before any SQL runs ---
  //
  // Resolved to `null` rather than a boolean because `null` is what the insert
  // loop below branches on. An empty string counts as ABSENT, not invalid: the
  // dashboard form posts `slug: ""` when the field is left blank, and treating
  // that as a validation failure would make an optional field mandatory.
  //
  // A non-string is NOT treated as absent — that would silently ignore a bug in
  // the caller's payload, and `12345` is exactly the kind of value that would
  // otherwise quietly become a printable slug nobody typed.
  let suppliedSlug: string | null = null;
  if (input.slug !== undefined && input.slug !== null && input.slug !== "") {
    const check = validateCustomSlug(input.slug);
    if (!check.valid) {
      throw new ValidationError(check.message, check.code);
    }
    suppliedSlug = input.slug;
  }

  // --- 3. Validate URL (open-redirect protection) ---
  //
  // Only when one was supplied. Card stock skips this entirely, which is the
  // point: there is nothing to protect against, because there is no destination
  // to be redirected to. The moment a destination is loaded it goes through
  // validateUrl like any other, so making the field optional never makes it
  // unvalidated.
  let original_url: string | null = null;
  if (input.original_url !== undefined) {
    const urlResult = validateUrl(input.original_url);
    if (!urlResult.valid) {
      throw new ValidationError(
        `Invalid URL: ${urlResult.error}`,
        urlResult.error ?? "invalid_url",
      );
    }
    // Use normalized URL (with https:// prepended if missing)
    original_url = urlResult.normalized ?? input.original_url;
  }

  // --- 4. Count active links (configured cap, T3.1) ---
  const countRow = await withClient(env, async (client) => {
    const table = qualifyTable(tenant.schemaName, "links");
    const res = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM ${table} WHERE is_active = true`,
    );
    return res.rows[0];
  });

  const activeCount = countRow ? parseInt(countRow.count, 10) : 0;
  const maxActiveLinks = resolveMaxActiveLinks(env);
  if (activeCount >= maxActiveLinks) {
    // The message reports the cap ACTUALLY IN FORCE. Interpolating a constant
    // here would state one number while enforcing another, so an operator who
    // raised the limit still reads "30" in the error.
    throw new LimitError(
      `Link limit reached (${maxActiveLinks} active links)`,
      "link_limit_reached",
    );
  }

  // --- 5. Create the link and claim its short code globally ---
  //
  // Two different uniqueness rules apply and both must hold:
  //
  //   `{tenant}.links.short_code` UNIQUE — per-tenant. It rejects a code this
  //     tenant already uses, but says nothing about other tenants. Two tenants
  //     CAN both hold 'abc1234'.
  //   `short_code_registry.short_code` PRIMARY KEY — global. Under the flat URL
  //     there is no slug to disambiguate with, so this is the constraint that
  //     actually makes a code resolvable.
  //
  // The registry insert therefore runs immediately after the link insert, and
  // its result is checked rather than assumed. If the claim loses, the link row
  // we just wrote is deleted again — returning it would hand the user a code
  // that resolves to somebody else's link.
  //
  // D1 — THE ATTEMPT BUDGET IS THE WHOLE POINT:
  //
  //   supplied slug → ONE attempt. A collision becomes a 409 naming the slug.
  //   generated code → MAX_RETRIES, drawing a fresh code each time.
  //
  // A retry here means a DIFFERENT short code. That is free when the code was
  // random, and catastrophic when the code is about to be printed on a sticker
  // that already exists in the world: `.../cafe-central` would resolve to
  // something else, permanently, with no way to recall the tags. So the two
  // paths share the insert logic and differ ONLY in how many attempts they get
  // and what they throw when they run out.
  const attempts = suppliedSlug !== null ? 1 : MAX_RETRIES;
  let linkRow: LinkRow | null = null;
  let claimedShortCode: string | null = null;

  for (let attempt = 0; attempt < attempts; attempt++) {
    // `??` rather than a ternary: with a supplied slug the generator is never
    // called at all, so there is no substitute code sitting in memory waiting
    // to be returned by accident.
    const shortCode = suppliedSlug ?? generateShortCode();

    const created = await withClient(env, async (client) => {
      const table = qualifyTable(tenant.schemaName, "links");

      const inserted = await client.query<LinkRow>(
        `INSERT INTO ${table} (original_url, short_code, title, expires_at, client_ref)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (short_code) DO NOTHING
         RETURNING id, short_code, original_url, title, client_ref, created_at`,
        [original_url, shortCode, title ?? null, expires_at ?? null, client_ref ?? null],
      );

      // No rows → this tenant already uses the code.
      if (inserted.rows.length === 0) return null;

      const link = inserted.rows[0]!;

      // Claim the code globally. ON CONFLICT DO NOTHING rather than an upsert:
      // overwriting would silently steal another tenant's code and repoint
      // their live short link at this URL.
      const claim = await client.query<{ short_code: string }>(
        `INSERT INTO public.short_code_registry (short_code, tenant_id, link_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (short_code) DO NOTHING
         RETURNING short_code`,
        [shortCode, tenant.tenantId, link.id],
      );

      if (claim.rows.length === 0) {
        // Taken by another tenant. Undo our own row — best effort, and a failure
        // here is surfaced by the caller's error mapping rather than swallowed.
        await client.query(`DELETE FROM ${table} WHERE id = $1`, [link.id]);
        return null;
      }

      return link;
    });

    if (created !== null) {
      linkRow = created;
      claimedShortCode = shortCode;
      break;
    }
  }

  if (!linkRow) {
    if (suppliedSlug !== null) {
      // D1: report the conflict. Never substitute a generated code — a 201 here
      // with a different short_code is the single worst outcome this endpoint
      // could produce, because it would look like success while every printed
      // sticker pointing at the requested slug resolves elsewhere.
      throw new ConflictError(
        `slug "${suppliedSlug}" is already taken`,
        "slug_taken",
      );
    }
    throw new Error("link_creation_failed");
  }

  // --- 6. Warm KV caches (fire-and-forget via waitUntil) ---
  const cachePayload = JSON.stringify({
    url: linkRow.original_url,
    isActive: true,
    expiresAt: expires_at ?? null,
    linkId: linkRow.id,
  });

  waitUntil(
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

  // The registry entry is warmed too: it is the first lookup every redirect
  // performs, so leaving it cold would put the join on the critical path of the
  // link's very first hit.
  waitUntil(
    setCachedRegistryEntry(env, claimedShortCode ?? linkRow.short_code, {
      tenantId: tenant.tenantId,
      schemaName: tenant.schemaName,
      tenantSalt: tenant.tenantSalt ?? "",
      subdomain: tenant.tenantSlug,
      linkId: linkRow.id,
    }).catch(() => {}),
  );

  // --- 7. Build response ---
  return {
    id: linkRow.id,
    short_code: linkRow.short_code,
    original_url: linkRow.original_url,
    short_url: `https://${env.SHORT_URL_DOMAIN}/${linkRow.short_code}`,
    title: linkRow.title,
    expires_at: expires_at ?? null,
    client_ref: linkRow.client_ref ?? null,
    created_at: linkRow.created_at,
  };
}

/**
 * Handles `POST /api/links` — authenticated link creation.
 *
 * Flow:
 * 1. Read authenticated user from context (auth middleware)
 * 2. Read tenant schema from context (tenant middleware — user-profile-based)
 * 3. Parse the JSON body
 * 4. Delegate to `createLinkCore`, which validates the URL and slug, enforces
 *    the configured active-link cap, claims the short code, and warms KV
 * 5. Return 201 with the created link resource
 *
 * This handler is deliberately thin. `POST /api/links/batch` calls the same core
 * function, so the two endpoints cannot disagree about what a valid link is.
 *
 * Error middleware wraps this handler — errors thrown here are caught and
 * mapped to appropriate HTTP status codes by the outermost errorHandler.
 */
export const createLink: Handler<{
  Bindings: AppEnv;
  Variables: HonoVars;
}> = async (c) => {
  let body: CreateLinkInput;
  try {
    body = await c.req.json<CreateLinkInput>();
  } catch {
    throw new ValidationError("Invalid JSON body", "invalid_request");
  }

  const link = await createLinkCore({
    env: c.env,
    tenant: c.get("tenant"),
    waitUntil: (p) => c.executionCtx.waitUntil(p),
    input: body ?? {},
  });

  return c.json(link, 201);
};

// ---------------------------------------------------------------------------
// GET /api/links — list the tenant's links
//
// THE RESPONSE IS A BARE ARRAY, and that is a contract, not an implementation
// detail.
//
// Phase 2 briefly returned `{ links: [...], clients: {...} }` so the
// per-client_ref visitor rollup could ride along in the same response. Nothing
// asked for that shape and it broke every consumer of the original one: a
// caller written against an array receives an object and fails on it. The
// dashboard survived only because it was rewritten in the same change.
//
// The rollup now has its own endpoint — GET /api/clients/metrics, see
// src/api/clients.ts — so there is nothing left to carry here and the array is
// restored exactly. Per-link fields are unchanged; only the container moved
// back. Adding a field to an existing collection means adding a field to each
// element, never a wrapper around the collection.
// ---------------------------------------------------------------------------

export const listLinks: Handler<{
  Bindings: AppEnv;
  Variables: HonoVars;
}> = async (c) => {
  const tenant = c.get("tenant");
  const table = qualifyTable(tenant.schemaName, "links");

  const rows = await withClient(c.env, async (client) => {
    const res = await client.query<LinkRow & { clicks_count: number; is_active: boolean; expires_at: string | null; updated_at: string; location_id: string | null; location_name: string | null }>(
      `SELECT l.id, l.short_code, l.original_url, l.title, l.client_ref, l.clicks_count,
              l.is_active, l.expires_at, l.created_at, l.updated_at,
              l.location_id, loc.name AS location_name
       FROM ${table} l
       LEFT JOIN public.locations loc ON loc.id = l.location_id
       ORDER BY l.created_at DESC
       LIMIT 100`,
    );

    return res.rows;
  });

  const domain = `https://${c.env.SHORT_URL_DOMAIN}`;

  return c.json(
    rows.map((r) => ({
      id: r.id,
      short_code: r.short_code,
      original_url: r.original_url,
      short_url: `${domain}/${r.short_code}`,
      title: r.title,
      client_ref: r.client_ref ?? null,
      location_id: r.location_id ?? null,
      location_name: r.location_name ?? null,
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
//
// A SLUG IS NOT AMONG THE UPDATABLE FIELDS, and that is a decision rather than
// an omission. One NFC tag or QR sticker per physical location is printed once
// and lives in the world for months; renaming a link breaks every sticker
// already out there, and there is no way to recall them. `short_code` is
// immutable by definition.
//
// So the field is REJECTED, not ignored. A silently-dropped `slug` would return
// `ok: true` and leave a caller believing a rename had landed while the printed
// tags quietly point at the old URL — the most expensive possible kind of
// "it said it worked".
// ---------------------------------------------------------------------------

export const updateLink: Handler<{
  Bindings: AppEnv;
  Variables: HonoVars;
}> = async (c) => {
  const tenant = c.get("tenant");
  const linkId = c.req.param("id")!;

  let body: {
    is_active?: boolean;
    title?: string;
    client_ref?: string;
    original_url?: string | null;
    slug?: unknown;
  };
  try {
    body = await c.req.json();
  } catch {
    throw new ValidationError("Invalid JSON body", "invalid_request");
  }

  // Checked before anything else, and before the DB is touched, so a rename
  // attempt cannot half-apply alongside a toggle or a client_ref write.
  if (body.slug !== undefined) {
    throw new ValidationError(
      "slug cannot be changed: a link's URL is immutable once printed",
      "slug_immutable",
    );
  }

  // --- original_url: the editable half ---
  //
  // `short_code` is immutable above, and this is the distinction the whole
  // card-stock feature rests on. The code is what is PRINTED, so it exists from
  // the moment the card does and can never change. The destination is what is
  // BEHIND the code, and nothing physical depends on it — which is exactly why
  // it can be loaded late, corrected, or cleared back to unconfigured without
  // touching a single sticker in the world.
  //
  // Empty string and null both mean "back to not configured". That is not
  // leniency for its own sake: a destination that is wrong is worse than one
  // that is absent, because absent reaches a page that says so while wrong
  // forwards customers somewhere unintended with no signal at all.
  if (body.original_url !== undefined) {
    if (body.original_url === null || body.original_url === "") {
      body.original_url = null;
    } else if (typeof body.original_url !== "string") {
      throw new ValidationError(
        "original_url must be a string or null",
        "invalid_request",
      );
    } else {
      const result = validateUrl(body.original_url);
      if (!result.valid) {
        throw new ValidationError(
          `Invalid URL: ${result.error}`,
          result.error ?? "invalid_url",
        );
      }
      body.original_url = result.normalized ?? body.original_url;
    }
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
    // Explicit null clears back to unconfigured. Takes no bind param, so it
    // must not consume a slot — the same rule client_ref follows.
    if (body.original_url === null) {
      sets.push(`original_url = NULL`);
    } else if (typeof body.original_url === "string") {
      sets.push(`original_url = $${vals.length + 1}`);
      vals.push(body.original_url);
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
  //
  // original_url joins this list for the same reason is_active is on it, and
  // it matters more here: the cache stores the DESTINATION, with a 24h TTL.
  // Load a destination onto a card and the redirect keeps serving the previous
  // one for up to a day, so the owner pastes the sticker, the customer scans,
  // and nothing happens — with no error anywhere to explain it.
  if (typeof body.is_active === "boolean" || body.original_url !== undefined) {
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

  const { short_code: shortCode } = rows[0]!;

  // Remove the registry row. A failure here is logged rather than propagated:
  // the destructive step has already committed, and what is left behind is a
  // registry row pointing at a tenant whose links table no longer holds the
  // code. That resolves to a 404 — which is the correct user-visible outcome —
  // so failing the whole request would trade a correct 200 for a misleading 500
  // over a leaked row that no longer affects anyone.
  try {
    await deleteRegistryRow(c.env, shortCode);
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "error",
        type: "registry_delete_failed",
        message: err instanceof Error ? err.message : String(err),
        tenant: tenant.tenantSlug,
        code: shortCode,
      }),
    );
  }

  // Both KV entries are invalidated regardless: the registry entry (the code no
  // longer resolves) and the short-URL entry (its destination is gone). The
  // second one matters most — it is what would keep serving a deleted link for
  // up to 24h.
  c.executionCtx.waitUntil(
    Promise.all([
      invalidateCachedRegistryEntry(c.env, shortCode),
      invalidateCachedUrl(c.env, tenant.tenantSlug, shortCode),
    ]).catch(() => {}),
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

    // --- Visitor figures: unique_visitors and sessions (Phase 2) ---
    //
    // Both come from ONE query over a de-duplicated (ip_hash, 30-minute
    // bucket) row set — see buildLinkVisitorMetricsQuery. Computed in SQL and
    // bounded by no LIMIT: folding these buckets in JavaScript is exactly the
    // pre-Phase-0 defect that reported a 50-row sample as the total.
    //
    // Deliberately not wrapped in a try/catch the way the referrer_source
    // aggregate above is. That fallback exists because the column may not
    // exist on an already-deployed database, and degrading a breakdown is
    // harmless. This one has no such drift risk, and a silent catch would
    // publish "0 unique visitors" — a confident "nobody came" — for a store
    // that was busy. An error is honest here.
    const visitorsQuery = buildLinkVisitorMetricsQuery(linkId);
    const visitorsRes = await client.query<VisitorMetricsRow>(
      visitorsQuery.text,
      visitorsQuery.params,
    );
    const visitorRow = visitorsRes.rows[0];

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

    return {
      groups,
      visitors: {
        unique_visitors: toCount(visitorRow?.unique_visitors ?? 0),
        sessions: toCount(visitorRow?.sessions ?? 0),
      },
      recent: recentRes.rows,
    };
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
    unique_visitors: result.visitors.unique_visitors,
    sessions: result.visitors.sessions,
    // Shipped with the figures so the dashboard labels can never drift from
    // the windows the SQL actually used.
    unique_window: UNIQUE_WINDOW,
    session_window: SESSION_WINDOW,
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
