import { Hono } from "hono";
import type { AppEnv, HonoVars } from "./types/env";

// Middleware
import { errorHandler } from "./middleware/error";
import { auth } from "./middleware/auth";
import { createUserProfileTenantMiddleware } from "./middleware/tenant";

// Handlers
import { landingHandler } from "./handlers/landing";
import { redirectHandler } from "./handlers/redirect";
import { createLink } from "./api/links";
import { createTenant, deleteTenant } from "./api/tenants";

// ---------------------------------------------------------------------------
// Middleware instances (pre-built — reused across all requests)
// ---------------------------------------------------------------------------

/** Tenant resolution for API routes: resolves from authenticated user's profile. */
const userProfileTenantMiddleware = createUserProfileTenantMiddleware();

// ---------------------------------------------------------------------------
// Application factory
// ---------------------------------------------------------------------------

/**
 * Creates a new Hono application instance with all routes registered.
 *
 * Called once per request in the Worker entry point. Each invocation creates
 * a fresh app instance to avoid shared mutable state across requests
 * (Workers best-practice: no module-level request state).
 */
export function createApp(_env: AppEnv): Hono<{ Bindings: AppEnv; Variables: HonoVars }> {
  const app = new Hono<{ Bindings: AppEnv; Variables: HonoVars }>();

  // Outermost error handler wraps all routes
  app.use("*", errorHandler);

  // -----------------------------------------------------------------------
  // Public routes
  // -----------------------------------------------------------------------

  // Landing page
  app.get("/", landingHandler);

  // Redirect — tenant resolved inline inside handler
  app.get("/r/:tenant/:code", redirectHandler);

  // -----------------------------------------------------------------------
  // API routes (authenticated)
  // -----------------------------------------------------------------------

  // Link creation: auth → resolve tenant from user profile → handler
  app.post("/api/links", auth, userProfileTenantMiddleware, createLink);

  // Tenant provisioning: auth required, no tenant middleware (tenant doesn't exist yet)
  app.post("/api/tenants", auth, createTenant);

  // Tenant deletion: auth required, ownership verified inside handler
  app.delete("/api/tenants/:id", auth, deleteTenant);

  return app;
}
