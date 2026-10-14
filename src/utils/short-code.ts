import { customAlphabet } from "nanoid";

/**
 * URL-safe alphabet with ambiguous characters removed:
 * - 0 (zero) and O (capital o)
 * - I (capital i) and 1 (one) and l (lowercase L)
 *
 * 57 characters total. At length 7: 57^7 ≈ 1.9 trillion combinations
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

// ---------------------------------------------------------------------------
// Caller-supplied slugs (T3.2)
//
// WHY THIS EXISTS SEPARATELY FROM generateShortCode
//
// The requirement is one NFC tag or QR sticker per physical location,
// PRE-PRINTED, living in the world for months. The URL on a sticker cannot
// change afterwards without re-printing every sticker.
//
// That inverts the usual generator contract. `generateShortCode` REGENERATES on
// an unusable draw, and that is correct — the user did not choose the code, so
// a second draw costs nothing. A slug the caller typed is the opposite: it is
// the literal string that will be embossed on a tag. Substituting anything for
// it produces stickers that point somewhere else, permanently, with no way to
// fix them.
//
// So this is a VALIDATOR, not a generator. It accepts or rejects; it never
// rewrites.
//
// It returns a result rather than throwing so the rule set stays pure and
// directly unit-testable, and so the caller (an HTTP handler) owns the decision
// to turn a failure into a ValidationError with an HTTP status.
// ---------------------------------------------------------------------------

/**
 * Shortest accepted slug.
 *
 * 3 matches the existing short-code minimum, so the two kinds of slug are not
 * governed by different lower bounds.
 */
export const MIN_CUSTOM_SLUG_LENGTH = 3;

/**
 * Longest accepted slug.
 *
 * Every character here is a character on every printed sticker, and it is a QR
 * module too. 32 keeps the artwork scannable at a comfortable physical size;
 * `cafe-central` is 12 and `x7f3b2q` is 6, and the user picks.
 */
export const MAX_CUSTOM_SLUG_LENGTH = 32;

/** Characters a slug may contain: letters, digits, underscore, hyphen. */
const SLUG_CHARSET = /^[A-Za-z0-9_-]+$/;

/** Outcome of checking a caller-supplied slug. */
export type CustomSlugCheck =
  | { valid: true }
  | { valid: false; code: string; message: string };

/**
 * Validates a caller-supplied slug against the printable-slug rules.
 *
 * | Rule | Rationale |
 * |---|---|
 * | 3–32 characters | 3 matches the code minimum; 32 keeps QR modules small |
 * | `[A-Za-z0-9_-]` only | No `/` — it breaks the single-segment route |
 * | No leading/trailing hyphen | `-foo` reads like a flag |
 * | Not in `RESERVED_ROUTES` | Would be unreachable; see below |
 * | Case-sensitive vs reserved | Hono matches paths case-sensitively |
 *
 * A non-string is rejected rather than coerced. `12345` stringifies to a
 * perfectly valid slug, and handing back a value the caller never typed as the
 * literal for a printed tag is exactly the failure this whole mechanism exists
 * to prevent.
 *
 * The reserved check is D2. A caller-supplied slug equal to an app route is not
 * an unlucky draw — it is an UNREACHABLE link: Hono resolves the static route
 * ahead of `/:code`, so the link 404s forever while still consuming a registry
 * row and a quota slot. Rejecting it is the only honest outcome, and it has to
 * happen at creation time, while the stickers are still unmade. The message
 * names the offending route so the user does not have to guess which word was
 * unavailable.
 *
 * Checks run most-specific-first: a value that is both too short AND contains a
 * slash reports the charset fault, because that is the one the user must fix
 * either way.
 */
export function validateCustomSlug(slug: unknown): CustomSlugCheck {
  if (typeof slug !== "string") {
    return {
      valid: false,
      code: "invalid_slug",
      message: "slug must be a string",
    };
  }

  if (slug.length < MIN_CUSTOM_SLUG_LENGTH || slug.length > MAX_CUSTOM_SLUG_LENGTH) {
    return {
      valid: false,
      code: "invalid_slug_length",
      message: `slug must be between ${MIN_CUSTOM_SLUG_LENGTH} and ${MAX_CUSTOM_SLUG_LENGTH} characters`,
    };
  }

  if (!SLUG_CHARSET.test(slug)) {
    return {
      valid: false,
      code: "invalid_slug_charset",
      message: "slug may only contain letters, numbers, hyphens and underscores",
    };
  }

  if (slug.startsWith("-") || slug.endsWith("-")) {
    return {
      valid: false,
      code: "invalid_slug_hyphen",
      message: "slug must not begin or end with a hyphen",
    };
  }

  if (isReservedShortCode(slug)) {
    return {
      valid: false,
      code: "reserved_slug",
      message: `slug "${slug}" is a reserved application route and would be unreachable`,
    };
  }

  return { valid: true };
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
