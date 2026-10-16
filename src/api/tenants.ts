import type { Handler } from "hono";
import type { AppEnv, HonoVars } from "../types/env";
import { withClient } from "../db/client";
import { validateSlug, sanitizeInput } from "../utils/validation";
import { provisionTenant } from "../tenants/provision";
import { deprovisionTenant } from "../tenants/deprovision";
import { setCachedTenant } from "../cache/tenant";
import {
  ValidationError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "../middleware/error";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TenantRow {
  id: string;
  schema_name: string;
  subdomain: string;
  owner_id: string;
  is_active: boolean;
  created_at: string;
}

// ---------------------------------------------------------------------------
// POST /api/tenants — Tenant provisioning
// ---------------------------------------------------------------------------

/**
 * Handles `POST /api/tenants`.
 *
 * Flow:
 * 1. Read authenticated user from context (auth middleware)
 * 2. Validate the requested subdomain slug
 * 3. Check uniqueness against `public.tenants`
 * 4. Delegate to `provisionTenant()` (DB transaction + KV warm)
 * 5. Return 201 with the new tenant resource
 */
export const createTenant: Handler<{
  Bindings: AppEnv;
  Variables: HonoVars;
}> = async (c) => {
  const env = c.env;
  const user = c.get("user");

  // --- 1. Parse request body ---
  let body: { subdomain?: string; display_name?: string };
  try {
    body = await c.req.json<{ subdomain?: string; display_name?: string }>();
  } catch {
    throw new ValidationError("Invalid JSON body", "invalid_request");
  }

  if (!body.subdomain || typeof body.subdomain !== "string") {
    throw new ValidationError("subdomain is required", "invalid_request");
  }

  const { subdomain, display_name } = body;
  const displayName = sanitizeInput(display_name ?? subdomain, 100);

  // --- 2. Validate slug ---
  const slugLower = subdomain.toLowerCase();
  const slugResult = validateSlug(slugLower);
  if (!slugResult.valid) {
    const code = slugResult.error ?? "invalid_slug";
    const messages: Record<string, string> = {
      invalid_slug: "Slug must be 3-30 characters, alphanumeric plus hyphens",
      reserved_slug: `"${slugLower}" is a reserved word`,
      slug_too_short: "Slug must be at least 3 characters",
      slug_too_long: "Slug must be at most 30 characters",
    };
    throw new ValidationError(messages[code] ?? "Invalid slug", code);
  }

  // --- 3. Check uniqueness ---
  const existing = await withClient(env, async (client) => {
    const res = await client.query<{ exists: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM public.tenants WHERE subdomain = $1) AS exists`,
      [slugLower],
    );
    return res.rows[0]?.exists ?? false;
  });

  if (existing) {
    throw new ConflictError(
      `Subdomain "${slugLower}" is already taken`,
      "subdomain_taken",
    );
  }

  // --- 4. Provision tenant ---
  const result = await provisionTenant(env, user.userId, slugLower, displayName);

  // --- 5. Warm KV cache (fire-and-forget via waitUntil) ---
  c.executionCtx.waitUntil(
    setCachedTenant(env, slugLower, {
      schemaName: result.schemaName,
      tenantId: result.tenantId,
      tenantSalt: result.tenantSalt,
    }).catch((err) => {
      console.error(
        JSON.stringify({
          event: "error",
          type: "kv_write_failed",
          message: err instanceof Error ? err.message : String(err),
          tenant: slugLower,
        }),
      );
    }),
  );

  // --- 6. Return 201 ---
  return c.json(
    {
      tenant_id: result.tenantId,
      subdomain: slugLower,
      schema_name: result.schemaName,
      display_name: displayName,
      created_at: new Date().toISOString(),
    },
    201,
  );
};

// ---------------------------------------------------------------------------
// DELETE /api/tenants/:id — Tenant deprovisioning
// ---------------------------------------------------------------------------

/**
 * Handles `DELETE /api/tenants/:id`.
 *
 * Flow:
 * 1. Read authenticated user from context (auth middleware)
 * 2. Verify the JWT userId matches the tenant's owner_id
 * 3. Delegate to `deprovisionTenant()` (DB transaction + side effects)
 * 4. Return 204 on success
 */
export const deleteTenant: Handler<{
  Bindings: AppEnv;
  Variables: HonoVars;
}> = async (c) => {
  const env = c.env;
  const user = c.get("user");
  const tenantId = c.req.param("id");

  if (!tenantId) {
    throw new ValidationError("Tenant ID is required", "invalid_request");
  }

  // --- 1. Verify ownership ---
  const rows = await withClient(env, async (client) => {
    const res = await client.query<TenantRow>(
      `SELECT id, schema_name, subdomain, owner_id
       FROM public.tenants
       WHERE id = $1`,
      [tenantId],
    );
    return res.rows;
  });

  if (rows.length === 0) {
    throw new NotFoundError("Tenant not found", "tenant_not_found");
  }

  const tenant = rows[0]!;

  if (tenant.owner_id !== user.userId) {
    throw new ForbiddenError("You are not the owner of this tenant");
  }

  // --- 2. Deprovision ---
  await deprovisionTenant(
    env,
    tenant.id,
    tenant.schema_name,
    tenant.subdomain,
    tenant.owner_id,
    c.executionCtx,
  );

  // --- 3. Return 204 ---
  return new Response(null, { status: 204 });
};

// ---------------------------------------------------------------------------

/**
 * Handles `GET /api/tenants` — the switcher's data source.
 *
 * Returns every active tenant the caller holds a membership in, and nothing
 * else. The predicate is `m.profile_id = $1` inside the SQL, so a tenant the
 * caller cannot reach is never loaded and then filtered: it is never loaded at
 * all. Deactivated tenants are excluded for the same reason the resolver
 * excludes them — a paused or removed business must not appear as switchable.
 *
 * Role travels with each entry because the switcher shows what the person may
 * do in that store, and a second call to learn it would be both slower and a
 * place for the two answers to disagree.
 */
export const listTenants: Handler<{
  Bindings: AppEnv;
  Variables: HonoVars;
}> = async (c) => {
  const user = c.get("user");
  if (!user?.userId) {
    return c.json({ error: "unauthenticated" }, 401);
  }

  let rows: {
    slug: string;
    schema_name: string;
    role: string;
    display_name: string | null;
  }[];
  try {
    rows = await withClient(c.env, async (client) => {
      const res = await client.query<{
        slug: string;
        schema_name: string;
        role: string;
        display_name: string | null;
      }>(
        `SELECT t.subdomain AS slug, t.schema_name, t.display_name, m.role
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
        type: "tenant_list_failed",
        message: err instanceof Error ? err.message : String(err),
        userId: user.userId,
      }),
    );
    return c.json({ error: "service_unavailable" }, 503);
  }

  return c.json({
    tenants: rows.map((r) => ({
      slug: r.slug,
      schemaName: r.schema_name,
      displayName: r.display_name ?? r.slug,
      role: r.role,
    })),
  });
};

/**
 * Where this tenant wants its private customer feedback sent.
 *
 * PHASE A: THIS RECORDS INTENT AND SENDS NOTHING.
 *
 * The column is stored, shown and exported so the owner can see it and a print
 * run can carry it. No provider is wired and the gate path is untouched, which
 * means this feature cannot break a customer's submission — and it means a
 * review does NOT reach the address yet. That is the honest state of it, and the
 * README says so rather than letting a green dashboard imply otherwise.
 */
export const getFeedbackEmail: Handler<{
  Bindings: AppEnv;
  Variables: HonoVars;
}> = async (c) => {
  const tenant = c.get("tenant");
  if (!tenant) return c.json({ error: "unauthenticated" }, 401);

  const row = await withClient(c.env, async (client) => {
    const res = await client.query<{ feedback_email: string | null }>(
      `SELECT feedback_email FROM public.tenants WHERE id = $1`,
      [tenant.tenantId],
    );
    return res.rows[0];
  });

  return c.json({ feedback_email: row?.feedback_email ?? null });
};

export const setFeedbackEmail: Handler<{
  Bindings: AppEnv;
  Variables: HonoVars;
}> = async (c) => {
  const tenant = c.get("tenant");
  if (!tenant) return c.json({ error: "unauthenticated" }, 401);

  let body: { feedback_email?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_request", code: "invalid_request" }, 400);
  }

  // Clearing is a first-class outcome, not an error: an owner who no longer wants
  // this set must be able to say so. `null` and "" both mean "not configured",
  // because a browser form submits "" for an emptied field.
  const raw = typeof body.feedback_email === "string" ? body.feedback_email.trim() : null;

  if (raw !== null && raw !== "" && !isPlausibleEmail(raw)) {
    return c.json(
      {
        error: "invalid_email",
        code: "invalid_email",
        detail: "That does not look like an email address.",
      },
      400,
    );
  }

  if (raw !== null && raw.length > 254) {
    // The RFC limit, and the column is TEXT so nothing below would stop it. A
    // value that long is a paste accident, and storing it would put a junk row
    // in the registry that an export then carries to every print run.
    return c.json({ error: "invalid_email", code: "invalid_email" }, 400);
  }

  const value = raw === "" ? null : raw;

  const row = await withClient(c.env, async (client) => {
    const res = await client.query<{ feedback_email: string | null }>(
      `UPDATE public.tenants SET feedback_email = $1 WHERE id = $2 RETURNING feedback_email`,
      [value, tenant.tenantId],
    );
    return res.rows[0];
  });

  return c.json({ feedback_email: row?.feedback_email ?? null });
};

/**
 * A deliberately loose email check.
 *
 * Strict RFC 5322 validation rejects addresses that deliver. The rule of thumb
 * from the original RFC is that anything with no whitespace, an `@`, and
 * something on each side of it gets delivered — so that is what this checks, and
 * anything more elaborate would refuse real addresses and teach the owner that
 * our form is unreliable.
 *
 * The length and whitespace rules are the parts that genuinely break delivery,
 * and they are the ones kept.
 */
export function isPlausibleEmail(value: string): boolean {
  if (/\s/.test(value)) return false;
  const parts = value.split("@");
  if (parts.length !== 2) return false;
  const [local, domain] = parts as [string, string];
  return local.length > 0 && domain.length > 0;
}
