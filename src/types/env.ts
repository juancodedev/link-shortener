/**
 * Supabase project secrets set via `wrangler secret put`.
 * These are NOT in wrangler.jsonc — they are runtime secrets.
 */
export interface SupabaseSecrets {
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  SUPABASE_JWT_SECRET: string;
  /** Direct connection string for local dev (bypasses Hyperdrive). Not set in production. */
  DATABASE_URL?: string;
  /**
   * Bearer token for the operator routes under `/api/ops`.
   *
   * Separate from SUPABASE_SERVICE_ROLE_KEY on purpose: that key is full database
   * access, and a credential whose only power is flipping a subscription should
   * not also be able to drop a schema. Optional so the routes fail closed with a
   * logged error when it is absent, rather than a TypeError at request time.
   */
  OPERATIONS_TOKEN?: string;
}

/**
 * Authenticated user extracted from a validated Supabase JWT.
 * Set on Hono context by the auth middleware.
 */
export interface AuthenticatedUser {
  userId: string;
  email: string;
}

/**
 * Tenant context resolved by the tenant middleware.
 * Set on Hono context for handlers that require tenant-aware queries.
 */
export interface TenantContext {
  tenantSlug: string;
  schemaName: string;
  tenantId: string;
  /** Per-tenant salt for IP hashing — retrieved from public.tenants.salt (REQ-A002). */
  tenantSalt: string;
  /**
   * Role this profile holds in THIS tenant, from `tenant_memberships.role`.
   *
   * Distinct from `public.profiles.role`, which is now inert. Permission checks
   * read this: it answers "what may this person do in the store they selected",
   * which a single global role could never express.
   *
   * Optional because it genuinely does not exist on the public redirect path:
   * `/<code>` is scanned by a customer, not a dashboard user, and there is no
   * profile behind it. Optional here means "no membership applies", which is
   * the truth — rather than a sentinel role that a later check might mistake
   * for a real one.
   */
  membershipRole?: string;
}

/**
 * Application configuration variables — operator-tunable settings, as opposed
 * to Supabase secrets.
 *
 * These live in `wrangler.jsonc`'s `vars` (or a `wrangler secret put` override),
 * NOT in the generated `Env` interface: `wrangler types` only emits the vars
 * present in the config at generation time, so a var added to this interface
 * without adding it to `wrangler.jsonc` and regenerating would not typecheck.
 * They are declared optional here precisely so the code reads them defensively
 * and has a defined answer when they are absent.
 */
export interface AppVars {
  /**
   * Maximum ACTIVE links a tenant may hold (T3.1).
   *
   * Read from the environment rather than hardcoded because the old constant,
   * `MAX_ACTIVE_LINKS = 30`, was a free-tier number that blocked the actual
   * deployment: one link per store. A chain of forty locations could not
   * onboard at all, and no tenant could change a constant buried in a handler.
   *
   * The guard itself is retained deliberately — a runaway-creation backstop has
   * real value — but the number is now something an operator sets per
   * deployment. Optional, because an unset value must fall back to a named
   * default rather than reject every creation.
   */
  MAX_ACTIVE_LINKS?: string;

  /**
   * Maximum links a tenant may hold as CARD STOCK — created without a
   * destination, awaiting one.
   *
   * Separate from `MAX_ACTIVE_LINKS` because a card is active from the moment it
   * is manufactured, so counting it against the link budget charged a tenant
   * their entire allowance for stickers they had not yet printed. An owner with
   * a hundred working cards could not manufacture fifty more.
   *
   * Bounded rather than unbounded: an unbounded creation path is how a loop bug
   * becomes an outage, and a stolen token should not be able to fill a table for
   * free.
   *
   * Optional for the same reason as `MAX_ACTIVE_LINKS`: an unset value falls
   * back to a named default rather than blocking every creation.
   */
  MAX_CARD_STOCK?: string;

  /**
   * Cloudflare rate limiter guarding `POST /api/gate`.
   *
   * Optional for the same reason as `MAX_ACTIVE_LINKS`: the binding exists in
   * `wrangler.jsonc`, but `wrangler types` only emits what it sees at generation
   * time, and tests inject a fake. Declaring it optional forces every read site
   * to decide what an absent limiter means — which for this endpoint is
   * "allow", because the alternative is a screen that stops working.
   */
  GATE_LIMITER?: RateLimit;

  /**
   * Where a paused business is told to go to reactivate — an email address or
   * an http(s) URL.
   *
   * Billing is collected off-platform, so there is no in-product checkout to
   * send them to. This is the operator's contact and it is how the pause page
   * gets its way out **without letting the customer reactivate themselves**:
   * the `/api/ops` routes exist precisely so a customer cannot grant their own
   * tenant `active`, and a checkout button here would be exactly that with
   * extra steps around it.
   *
   * Optional because a deployment with no support address should still render a
   * usable page — it omits the link rather than printing an empty `mailto:`.
   */
  BILLING_CONTACT?: string;
}

/**
 * Full application environment combining generated bindings (KV, Hyperdrive, vars)
 * with Supabase secrets. Extends the globally-declared Env interface from
 * worker-configuration.d.ts (generated by `pnpm run types`).
 */
export type AppEnv = Env & SupabaseSecrets & AppVars;

/**
 * Hono context variables populated by middleware.
 *
 * Hono's `c.set()` / `c.get()` are typed via the Variables generic param.
 * This interface maps variable names to their runtime types so Hono can
 * statically check `c.set('user', ...)` and `c.get('user')` calls.
 */
export interface HonoVars {
  user: AuthenticatedUser;
  tenant: TenantContext;
}
