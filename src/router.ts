import { Hono } from "hono";
import type { AppEnv, HonoVars } from "./types/env";

// Middleware
import { errorHandler } from "./middleware/error";
import { auth } from "./middleware/auth";
import { createUserProfileTenantMiddleware } from "./middleware/tenant";

// Handlers
import { landingHandler } from "./handlers/landing";
import { redirectHandler } from "./handlers/redirect";
import { signupHandler, loginHandler, resetPasswordHandler, authCallbackHandler } from "./handlers/auth";
import { dashboardHandler } from "./handlers/dashboard";
import { createLink, listLinks, updateLink, deleteLink, linkClicks } from "./api/links";
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

  // Outermost error handler. Registered via `onError` (not `app.use("*")`):
  // Hono catches a handler's throw on that handler's own frame, so an
  // `await next()` middleware never sees it.
  app.onError(errorHandler);

  // -----------------------------------------------------------------------
  // Public routes
  // -----------------------------------------------------------------------

  // Landing page
  app.get("/", landingHandler);

  // Auth pages (public)
  app.get("/signup", signupHandler);
  app.get("/login", loginHandler);
  app.get("/reset-password", resetPasswordHandler);
  app.get("/auth/callback", authCallbackHandler);

  // Redirect — tenant resolved inline inside handler
  app.get("/r/:tenant/:code", redirectHandler);

  // Dashboard (authenticated via client-side Supabase session)
  app.get("/dashboard", dashboardHandler);

  // -----------------------------------------------------------------------
  // API routes (authenticated)
  // -----------------------------------------------------------------------

  // Link CRUD: auth → resolve tenant from user profile → handler
  app.post("/api/links", auth, userProfileTenantMiddleware, createLink);
  app.get("/api/links", auth, userProfileTenantMiddleware, listLinks);
  app.patch("/api/links/:id", auth, userProfileTenantMiddleware, updateLink);
  app.delete("/api/links/:id", auth, userProfileTenantMiddleware, deleteLink);
  app.get("/api/links/:id/clicks", auth, userProfileTenantMiddleware, linkClicks);

  // Tenant provisioning: auth required, no tenant middleware (tenant doesn't exist yet)
  app.post("/api/tenants", auth, createTenant);

  // Tenant deletion: auth required, ownership verified inside handler
  app.delete("/api/tenants/:id", auth, deleteTenant);

  return app;
}
