import type { Handler } from "hono";
import type { AppEnv, HonoVars } from "../types/env";
import { withClient } from "../db/client";
import { validateSlug, sanitizeInput } from "../utils/validation";
import { provisionTenant } from "../tenants/provision";
import { deprovisionTenant } from "../tenants/deprovision";
import { setCachedSchema } from "../cache/tenant";
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
    setCachedSchema(env, slugLower, result.schemaName).catch((err) => {
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
