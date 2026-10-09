import { customAlphabet } from "nanoid";

/**
 * URL-safe alphabet with ambiguous characters removed:
 * - 0 (zero) and O (capital o)
 * - I (capital i) and 1 (one) and l (lowercase L)
 *
 * 54 characters total. At length 7: ~54^7 ≈ 1.5 trillion combinations
 * — sufficient for global uniqueness.
 */
const ALPHABET =
  "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const nanoid = customAlphabet(ALPHABET, 7);

/**
 * Single-segment app routes a generated short code must never equal.
 *
 * Public links are flat — `https://<domain>/<code>` — so every one-segment path
 * that is not a registered app route is read as a short code, and Hono resolves
 * a registered static route ahead of `/:code`. A code equal to one of these
 * would be unreachable: the app route wins the match, so the link 404s forever
 * while still consuming a registry row and a slot of the free-tier quota.
 *
 * This list is the single source of truth. `test/utils/short-code.test.ts`
 * derives the routes actually registered in `src/router.ts` and fails if this
 * list does not cover them, so adding an app route here is not optional.
 *
 * `/` needs no entry: it is not a single segment, so `/:code` cannot match it.
 * Multi-segment routes (`/api/links`, `/auth/callback`) cannot match `/:code`
 * either, which is why they are absent here rather than omitted by oversight.
 */
export const RESERVED_ROUTES = ["signup", "login", "dashboard", "reset-password"] as const;

const RESERVED_ROUTE_SET: ReadonlySet<string> = new Set(RESERVED_ROUTES);

/**
 * True when a short code would collide with a registered app route.
 *
 * Case-sensitive on purpose: Hono matches paths case-sensitively, so `Dashboard`
 * is a free short code and only `dashboard` is shadowed.
 */
export function isReservedShortCode(code: string): boolean {
  return RESERVED_ROUTE_SET.has(code);
}

/**
 * Upper bound on regeneration attempts before giving up.
 *
 * Reaching it requires the generator to draw a reserved route three times in a
 * row. With the current 7-character alphabet that is impossible — none of the
 * reserved names is 7 characters — so this is a bound, not a retry policy that
 * runs in practice. It exists so the guard cannot become an unbounded loop if
 * the alphabet or a route name changes.
 */
const MAX_RESERVED_RETRIES = 5;

/**
 * Generates a URL-safe 7-character short code.
 *
 * A reserved route is regenerated rather than returned, so a caller can never
 * be handed a code that `/:code` will not resolve.
 *
 * Uses cryptographically secure random values via nanoid. Uniqueness is enforced
 * globally by `public.short_code_registry.short_code` (PRIMARY KEY) plus retry on
 * insert — the per-tenant UNIQUE constraint only guarantees uniqueness within a
 * schema, which the flat URL format cannot use to disambiguate.
 *
 * @throws If MAX_RESERVED_RETRIES draws all come back reserved.
 */
export function generateShortCode(): string {
  for (let attempt = 0; attempt < MAX_RESERVED_RETRIES; attempt++) {
    const code = nanoid();
    if (!isReservedShortCode(code)) return code;
  }
  throw new Error("short_code_generation_failed");
}
