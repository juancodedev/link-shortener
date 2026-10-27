import type { Handler } from "hono";
import type { AppEnv, HonoVars } from "../types/env";
import { withClient } from "../db/client";
import { qualifyTable } from "../db/schema";
import { ValidationError, NotFoundError } from "../middleware/error";
import { isUuid } from "../utils/validation";

// ---------------------------------------------------------------------------
// Locations — /api/locations
//
// A location is one table, one zone, one wall: the physical place a sticker
// lives. `links.location_id` points at one, and the per-location rollup groups
// scans by it — so a location is what turns "which tables actually convert"
// from a tenant-wide number into an answer an owner can act on.
//
// WHY THIS EXISTS NOW
//
// The table shipped in 00006 with a backfill that gives every existing tenant
// one location named after itself, and PR #62 made `links.location_id`
// settable, and PR #63 made a scan carry it through to the rollup. Every half
// of the measurement path was in place and none of it was reachable: creating a
// location meant running SQL in the Supabase console.
//
// That is the wrong shape for this product. Its customer is a business owner,
// not an operator with database access. A feature that works only from the
// console is not a feature, it is a hint.
//
// SCOPE, DELIBERATELY SMALL
//
// CRUD on locations and nothing else. There is no usage metric here, because
// the rollup already answers that and two sources for one number is how they
// drift. `is_active` exists for the day a table is retired, but there is no
// archive route: deleting a location whose links point at it would either fail
// or orphan them, and neither is worth the surface.
//
// A location is also a BRANCH ("sucursal") of a business ("local"), through the
// nullable `business_id` added in 00018. See src/api/businesses.ts.
//
// Location ids are uuids, so they are safe to interpolate — but they are still
// filtered on `tenant_id` in every query here. "A valid uuid" is not "yours",
// and an unfiltered lookup would let one business enumerate another's tables.
// ---------------------------------------------------------------------------

interface LocationRow {
  id: string;
  name: string;
  slug: string;
  is_active: boolean;
  created_at: string;
  business_id?: string | null;
}

/** Longest accepted display name. A label is not free storage. */
const MAX_NAME_LENGTH = 120;

/**
 * The database's own slug rule, restated so the caller learns about it from a
 * 400 rather than from a constraint violation at INSERT time.
 *
 * Lowercase, hyphen-separated, no leading or trailing hyphen — deliberately the
 * same shape as a printable link slug, because a location label and a sticker
 * slug should read alike to the owner typing both.
 */
const SLUG_RE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;

export interface LocationResource {
  id: string;
  name: string;
  slug: string;
  is_active: boolean;
  /** Links currently attached to this location. Cheap: one grouped count. */
  link_count: number;
  /** The business ("local") this branch belongs to, or null. */
  business_id: string | null;
  business_name: string | null;
}

/** Validates the parts shared by create and update. */
function validateName(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new ValidationError("name must be a string", "invalid_request");
  }
  const name = raw.trim();
  if (name.length === 0) {
    throw new ValidationError("name is required", "invalid_request");
  }
  if (name.length > MAX_NAME_LENGTH) {
    throw new ValidationError(
      `name must be at most ${MAX_NAME_LENGTH} characters`,
      "invalid_request",
    );
  }
  return name;
}

function validateSlug(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new ValidationError("slug must be a string", "invalid_request");
  }
  const slug = raw.trim().toLowerCase();
  if (!SLUG_RE.test(slug)) {
    throw new ValidationError(
      "slug must be lowercase letters, digits and hyphens, with no leading or trailing hyphen",
      "invalid_request",
    );
  }
  return slug;
}

/**
 * Validates an optional `business_id` and proves the tenant owns it.
 *
 * Returns `undefined` when the field is absent (leave it alone), `null` for an
 * explicit detach, and the id otherwise. Ownership is checked with its own
 * tenant-filtered read BEFORE the write: the foreign key only proves the
 * business exists, not that it is this tenant's, and a branch filed under
 * another operator's business would show up in their grouping.
 */
async function resolveBusinessId(
  env: AppEnv,
  tenantId: string,
  raw: unknown,
): Promise<string | null | undefined> {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw !== "string" || !isUuid(raw)) {
    throw new ValidationError("business_id must be a uuid or null", "invalid_business_id");
  }
  const found = await withClient(env, async (client) => {
    const res = await client.query<{ id: string }>(
      `SELECT id FROM public.businesses WHERE id = $1 AND tenant_id = $2`,
      [raw, tenantId],
    );
    return res.rows.length > 0;
  });
  if (!found) {
    throw new ValidationError("business_id does not belong to this tenant", "invalid_business_id");
  }
  return raw;
}

/** Turns an unknown thrown value into a 409 naming the collision. */
function mapLocationError(err: unknown): never {
  // 23505 is unique_violation. Postgres reports the index name in the message,
  // and this repo has exactly one index covering (tenant_id, slug), so the
  // collision is unambiguous rather than guessed at.
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes("idx_locations_tenant_slug")) {
    throw new ValidationError("slug already exists for this tenant", "slug_taken");
  }
  throw err;
}

// ---------------------------------------------------------------------------
// GET /api/locations
// ---------------------------------------------------------------------------

/**
 * Lists the tenant's locations with a link count each.
 *
 * The count is what lets an owner decide which table to retire: a location with
 * twelve links and no scans is a different decision from one with none.
 *
 * `LEFT JOIN` on purpose, matching the rollup's own query: a location with no
 * links must still appear, or a newly created table looks like it does not
 * exist.
 */
export const listLocations: Handler<{
  Bindings: AppEnv;
  Variables: HonoVars;
}> = async (c) => {
  const tenant = c.get("tenant");

  // The links table lives in the TENANT schema, not in public, so the count is
  // a correlated subquery against the qualified name rather than a join. That
  // is what makes the tenant filter on the outer query load-bearing: the
  // locations list is public, the count is per-tenant, and a scope that dropped
  // the qualifier would either throw or read another tenant's links.
  const table = qualifyTable(tenant.schemaName, "links");

  const rows = await withClient(c.env, async (client) => {
    // LEFT JOIN on businesses: a branch nobody has grouped yet must still be
    // listed, with a null business, or it could never be assigned one.
    const res = await client.query<
      LocationRow & { link_count: string; business_name: string | null }
    >(
      `SELECT l.id, l.name, l.slug, l.is_active, l.created_at, l.business_id,
              b.name AS business_name,
              (SELECT COUNT(*)::text FROM ${table} k WHERE k.location_id = l.id)
                AS link_count
         FROM public.locations l
         LEFT JOIN public.businesses b ON b.id = l.business_id
        WHERE l.tenant_id = $1
        ORDER BY b.name ASC NULLS LAST, l.name ASC`,
      [tenant.tenantId],
    );
    return res.rows;
  });

  const locations: LocationResource[] = rows.map((r) => ({
    id: r.id,
    name: r.name,
    slug: r.slug,
    is_active: r.is_active,
    // Postgres hands COUNT back as a string; a JSON number here would render as
    // "12" in the dashboard's copy and read as a defect.
    link_count: Number(r.link_count),
    business_id: r.business_id ?? null,
    business_name: r.business_name ?? null,
  }));

  return c.json({ locations });
};

// ---------------------------------------------------------------------------
// POST /api/locations
// ---------------------------------------------------------------------------

/**
 * Creates a location.
 *
 * A caller-supplied slug is optional. When absent one is derived from the name,
 * because "Mesa 1" should not also mean typing `mesa-1` by hand — and a
 * collision is reported rather than silently suffixed, because two locations
 * called `mesa-1` and `mesa-1-2` are indistinguishable to the owner who has to
 * choose between them later.
 */
export const createLocation: Handler<{
  Bindings: AppEnv;
  Variables: HonoVars;
}> = async (c) => {
  const tenant = c.get("tenant");

  let body: { name?: unknown; slug?: unknown; business_id?: unknown };
  try {
    body = await c.req.json();
  } catch {
    throw new ValidationError("Invalid JSON body", "invalid_request");
  }

  const name = validateName(body.name);

  let slug: string;
  if (body.slug === undefined || body.slug === null || body.slug === "") {
    slug = slugify(name);
    if (!SLUG_RE.test(slug)) {
      throw new ValidationError(
        "name does not produce a usable slug; supply one explicitly",
        "invalid_request",
      );
    }
  } else {
    slug = validateSlug(body.slug);
  }

  const businessId = (await resolveBusinessId(c.env, tenant.tenantId, body.business_id)) ?? null;

  try {
    const row = await withClient(c.env, async (client) => {
      const res = await client.query<LocationRow>(
        `INSERT INTO public.locations (tenant_id, name, slug, business_id)
         VALUES ($1, $2, $3, $4)
         RETURNING id, name, slug, is_active, created_at, business_id`,
        [tenant.tenantId, name, slug, businessId],
      );
      return res.rows[0]!;
    });

    return c.json(
      {
        location: {
          id: row.id,
          name: row.name,
          slug: row.slug,
          is_active: row.is_active,
          link_count: 0,
          business_id: row.business_id ?? null,
        },
      },
      201,
    );
  } catch (err) {
    mapLocationError(err);
  }
};

// ---------------------------------------------------------------------------
// PATCH /api/locations/:id
// ---------------------------------------------------------------------------

/**
 * Renames a location or switches it off.
 *
 * `slug` is NOT editable. It is derived from the name and it appears on printed
 * material next to the short code, so changing it would orphan whatever the
 * designer already produced. Rejected rather than ignored, for the same reason
 * `links.slug` is: a silently-dropped rename returns `ok: true` and leaves the
 * caller believing it landed.
 */
export const updateLocation: Handler<{
  Bindings: AppEnv;
  Variables: HonoVars;
}> = async (c) => {
  const tenant = c.get("tenant");
  const id = c.req.param("id")!;

  let body: { name?: unknown; is_active?: unknown; slug?: unknown; business_id?: unknown };
  try {
    body = await c.req.json();
  } catch {
    throw new ValidationError("Invalid JSON body", "invalid_request");
  }

  if (body.slug !== undefined) {
    throw new ValidationError(
      "slug cannot be changed: it appears on printed material",
      "slug_immutable",
    );
  }

  const sets: string[] = [];
  const vals: (string | boolean | null)[] = [];

  if (body.name !== undefined) {
    sets.push(`name = $${vals.length + 1}`);
    vals.push(validateName(body.name));
  }
  if (body.is_active !== undefined) {
    if (typeof body.is_active !== "boolean") {
      throw new ValidationError("is_active must be a boolean", "invalid_request");
    }
    sets.push(`is_active = $${vals.length + 1}`);
    vals.push(body.is_active);
  }

  const businessId = await resolveBusinessId(c.env, tenant.tenantId, body.business_id);
  if (businessId !== undefined) {
    sets.push(`business_id = $${vals.length + 1}`);
    vals.push(businessId);
  }

  if (sets.length === 0) {
    throw new ValidationError("No fields to update", "invalid_request");
  }

  // tenant_id in the WHERE, not just in the lookup above: a caller that owns
  // the id should still not be able to update a row that belongs elsewhere.
  const rows = await withClient(c.env, async (client) => {
    const res = await client.query<LocationRow>(
      `UPDATE public.locations SET ${sets.join(", ")}
        WHERE id = $${vals.length + 1} AND tenant_id = $${vals.length + 2}
        RETURNING id, name, slug, is_active, created_at`,
      [...vals, id, tenant.tenantId],
    );
    return res.rows;
  });

  if (rows.length === 0) throw new NotFoundError("Location not found", "not_found");

  return c.json({ ok: true });
};

/**
 * Derives a slug from a display name.
 *
 * Accents are folded rather than dropped: "Mesa Ñoqui" has to become
 * `mesa-noqui`, not `mesa-ooqui`, or the owner gets a slug that means something
 * different from the name they can see.
 */
function slugify(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30);
}