import type { Handler } from "hono";
import type { AppEnv, HonoVars } from "../types/env";
import { withClient } from "../db/client";
import { ValidationError, NotFoundError } from "../middleware/error";
import { isUuid } from "../utils/validation";

// ---------------------------------------------------------------------------
// Businesses — /api/businesses
//
// A business is a "local": the café, the restaurant, the shop. It groups one or
// more locations ("sucursales", branches), and through them every link, scan,
// rating and comment. See supabase/migrations/00018_businesses.sql for why this
// is a level inside the tenant rather than a tenant of its own.
//
// Shaped like /api/locations on purpose: list, create, rename or switch off.
// There is no delete route — a business with branches would either fail the
// delete or detach them, and neither is worth the surface yet.
//
// Every query filters on `tenant_id`. A business id is a uuid, and "a valid
// uuid" is not "yours".
// ---------------------------------------------------------------------------

interface BusinessRow {
  id: string;
  name: string;
  is_active: boolean;
  created_at: string;
}

export interface BusinessResource {
  id: string;
  name: string;
  is_active: boolean;
  /** Branches (locations) currently grouped under this business. */
  location_count: number;
}

/** Longest accepted display name. Matches the locations API. */
const MAX_NAME_LENGTH = 120;

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

/** Turns the unique-name collision into a 409 rather than a 500. */
function mapBusinessError(err: unknown): never {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes("idx_businesses_tenant_name")) {
    throw new ValidationError("a business with this name already exists", "name_taken");
  }
  throw err;
}

// ---------------------------------------------------------------------------
// GET /api/businesses
// ---------------------------------------------------------------------------

export const listBusinesses: Handler<{
  Bindings: AppEnv;
  Variables: HonoVars;
}> = async (c) => {
  const tenant = c.get("tenant");

  const rows = await withClient(c.env, async (client) => {
    const res = await client.query<BusinessRow & { location_count: string }>(
      `SELECT b.id, b.name, b.is_active, b.created_at,
              (SELECT COUNT(*)::text FROM public.locations l WHERE l.business_id = b.id)
                AS location_count
         FROM public.businesses b
        WHERE b.tenant_id = $1
        ORDER BY b.name ASC`,
      [tenant.tenantId],
    );
    return res.rows;
  });

  const businesses: BusinessResource[] = rows.map((r) => ({
    id: r.id,
    name: r.name,
    is_active: r.is_active,
    // COUNT comes back as a string; the dashboard renders it as a number.
    location_count: Number(r.location_count),
  }));

  return c.json({ businesses });
};

// ---------------------------------------------------------------------------
// POST /api/businesses
// ---------------------------------------------------------------------------

export const createBusiness: Handler<{
  Bindings: AppEnv;
  Variables: HonoVars;
}> = async (c) => {
  const tenant = c.get("tenant");

  let body: { name?: unknown };
  try {
    body = await c.req.json();
  } catch {
    throw new ValidationError("Invalid JSON body", "invalid_request");
  }

  const name = validateName(body.name);

  try {
    const row = await withClient(c.env, async (client) => {
      const res = await client.query<BusinessRow>(
        `INSERT INTO public.businesses (tenant_id, name)
         VALUES ($1, $2)
         RETURNING id, name, is_active, created_at`,
        [tenant.tenantId, name],
      );
      return res.rows[0]!;
    });

    return c.json(
      {
        business: { id: row.id, name: row.name, is_active: row.is_active, location_count: 0 },
      },
      201,
    );
  } catch (err) {
    mapBusinessError(err);
  }
};

// ---------------------------------------------------------------------------
// PATCH /api/businesses/:id
// ---------------------------------------------------------------------------

export const updateBusiness: Handler<{
  Bindings: AppEnv;
  Variables: HonoVars;
}> = async (c) => {
  const tenant = c.get("tenant");
  const id = c.req.param("id")!;
  // Not a uuid cannot be one of yours; asking Postgres would fail the cast
  // and surface as a 500.
  if (!isUuid(id)) throw new NotFoundError("Business not found", "not_found");

  let body: { name?: unknown; is_active?: unknown };
  try {
    body = await c.req.json();
  } catch {
    throw new ValidationError("Invalid JSON body", "invalid_request");
  }

  const sets: string[] = [];
  const vals: (string | boolean)[] = [];

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

  if (sets.length === 0) {
    throw new ValidationError("No fields to update", "invalid_request");
  }

  let rows: BusinessRow[];
  try {
    rows = await withClient(c.env, async (client) => {
      const res = await client.query<BusinessRow>(
        `UPDATE public.businesses SET ${sets.join(", ")}
          WHERE id = $${vals.length + 1} AND tenant_id = $${vals.length + 2}
          RETURNING id, name, is_active, created_at`,
        [...vals, id, tenant.tenantId],
      );
      return res.rows;
    });
  } catch (err) {
    mapBusinessError(err);
  }

  if (rows.length === 0) throw new NotFoundError("Business not found", "not_found");

  return c.json({ ok: true });
};
