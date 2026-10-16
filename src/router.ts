import { Hono } from "hono";
import type { AppEnv, HonoVars } from "./types/env";

// Middleware
import { errorHandler } from "./middleware/error";
import { auth } from "./middleware/auth";
import { createTenantMembershipMiddleware } from "./middleware/tenant";

// Handlers
import { landingHandler } from "./handlers/landing";
import { redirectHandler } from "./handlers/redirect";
import { signupHandler, loginHandler, resetPasswordHandler, authCallbackHandler } from "./handlers/auth";
import { dashboardHandler } from "./handlers/dashboard";
import { gateHandler } from "./handlers/gate";
import { createLink, listLinks, updateLink, deleteLink, linkClicks } from "./api/links";
import { createLinksBatch } from "./api/batch";
import { listClientRefMetrics } from "./api/clients";
import { listLocations, createLocation, updateLocation } from "./api/locations";
import { linkQrSvg, batchQrSheet } from "./api/qr";
import { reviewGateMetrics } from "./api/review-gate";
import { createTenant, deleteTenant, listTenants } from "./api/tenants";
import { listTenantSubscriptions, setTenantSubscription } from "./handlers/ops";

// ---------------------------------------------------------------------------
// Middleware instances (pre-built — reused across all requests)
// ---------------------------------------------------------------------------

/** Tenant resolution for API routes: resolves from authenticated user's profile. */
const tenantMembershipMiddleware = createTenantMembershipMiddleware();

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

  // The action screen's recorder. Public by necessity: the person scanning a
  // sticker is a customer of the business, not a user of this dashboard, so
  // requiring a JWT here would mean the product cannot work at all.
  app.post("/api/gate", gateHandler);

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
  app.post("/api/links", auth, tenantMembershipMiddleware, createLink);
  app.get("/api/links", auth, tenantMembershipMiddleware, listLinks);
  app.patch("/api/links/:id", auth, tenantMembershipMiddleware, updateLink);
  app.delete("/api/links/:id", auth, tenantMembershipMiddleware, deleteLink);
  app.get("/api/links/:id/clicks", auth, tenantMembershipMiddleware, linkClicks);

  // Batch creation: auth → resolve tenant from user profile → handler.
  //
  // THE MIDDLEWARE CHAIN IS LOAD-BEARING, NOT DECORATIVE. The handler qualifies
  // every query against `c.get("tenant").schemaName`. Registering this route
  // with `auth` alone would not merely return the wrong numbers — it would throw
  // on an undefined tenant, and any later edit that made it tolerate that would
  // read across tenants. It is identical to the routes above for exactly that
  // reason, not for tidiness.
  app.post("/api/links/batch", auth, tenantMembershipMiddleware, createLinksBatch);

  // Per-client_ref visitor rollup: auth → resolve tenant from user profile →
  // handler. The same chain as every other tenant-scoped route above, and for
  // the same reason: the tenant in context is what qualifies the links table the
  // rollup joins against, so omitting it would read across tenants.
  //
  // Its own route rather than part of the GET /api/links payload — carrying it
  // there changed that response from a bare array into an envelope. See
  // src/api/clients.ts for the full reasoning.
  app.get("/api/clients/metrics", auth, tenantMembershipMiddleware, listClientRefMetrics);

  // Locations — one table, one zone, one wall. The same chain as every other
  // tenant-scoped route above, for the same reason: the links COUNT is a
  // correlated subquery against the tenant's own schema, so omitting the
  // middleware would not merely return wrong numbers, it would throw.
  // Server-rendered QR. The print sheet is what removes the dependency on a
  // third-party image service for the one artefact that leaves this system and
  // comes back as ink on paper.
  app.get("/api/links/:id/qr.svg", auth, tenantMembershipMiddleware, linkQrSvg);
  app.post("/api/links/qr-sheet.zip", auth, tenantMembershipMiddleware, batchQrSheet);

  app.get("/api/locations", auth, tenantMembershipMiddleware, listLocations);
  app.post("/api/locations", auth, tenantMembershipMiddleware, createLocation);
  app.patch("/api/locations/:id", auth, tenantMembershipMiddleware, updateLocation);

  // The action screen's three views in one response. They describe the same
  // scans and the dashboard renders them on one screen, so fetching them
  // separately would let the numbers disagree in front of the owner.
  app.get("/api/review-gate/metrics", auth, tenantMembershipMiddleware, reviewGateMetrics);

  // Tenant provisioning: auth required, no tenant middleware (tenant doesn't exist yet)
  // -----------------------------------------------------------------------
  // Operator routes — bearer OPERATIONS_TOKEN, never a customer JWT.
  // Billing is collected off-platform and recorded here, so a customer able to
  // flip their own status would grant themselves 'active' instead of paying.
  // -----------------------------------------------------------------------

  app.get("/api/ops/tenants", listTenantSubscriptions);
  app.post("/api/ops/tenants/subscription", setTenantSubscription);

  app.get("/api/tenants", auth, listTenants);
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
