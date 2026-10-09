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
import { listClientRefMetrics } from "./api/clients";
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

  // Per-client_ref visitor rollup: auth → resolve tenant from user profile →
  // handler. The same chain as every other tenant-scoped route above, and for
  // the same reason: the tenant in context is what qualifies the links table the
  // rollup joins against, so omitting it would read across tenants.
  //
  // Its own route rather than part of the GET /api/links payload — carrying it
  // there changed that response from a bare array into an envelope. See
  // src/api/clients.ts for the full reasoning.
  app.get("/api/clients/metrics", auth, userProfileTenantMiddleware, listClientRefMetrics);

  // Tenant provisioning: auth required, no tenant middleware (tenant doesn't exist yet)
  app.post("/api/tenants", auth, createTenant);

  // Tenant deletion: auth required, ownership verified inside handler
  app.delete("/api/tenants/:id", auth, deleteTenant);

  // -----------------------------------------------------------------------
  // Catch-all short link — registered LAST, deliberately.
  //
  // `/:code` matches every single-segment path that no earlier route claimed,
  // so its position is part of its contract: Hono resolves a registered static
  // route ahead of a single-segment parameter, which is what keeps /dashboard
  // and the auth pages working. Moving this registration above them would not
  // change that precedence, but it would make the router read as though the
  // catch-all could win, and it would break the ordering the test in
  // test/router.test.ts asserts.
  //
  // The tenant is resolved inside the handler through
  // public.short_code_registry, not from the path — see src/handlers/redirect.ts.
  // -----------------------------------------------------------------------
  app.get("/:code", redirectHandler);

  return app;
}
