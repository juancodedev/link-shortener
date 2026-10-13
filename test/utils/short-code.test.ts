import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Controlled nanoid
//
// The reserved-route guard is a REGENERATE-until-not-reserved loop, which is
// unobservable through the real random generator: a 7-character code can never
// equal "login" (5) or "dashboard" (9) anyway, so the guard would pass whether
// or not it existed.
//
// This mock lets a test push an exact sequence of codes — reserved first, then a
// usable one — and assert that the reserved one is skipped rather than returned.
// With the queue empty the wrapper delegates to the real generator, so the
// alphabet/length/uniqueness tests below exercise the genuine implementation.
// ---------------------------------------------------------------------------

const nanoidState = vi.hoisted(() => ({ queue: [] as string[] }));

vi.mock("nanoid", async (importOriginal) => {
  const actual = await importOriginal<typeof import("nanoid")>();
  return {
    customAlphabet: (alphabet: string, size: number) => {
      const random = actual.customAlphabet(alphabet, size);
      return () => (nanoidState.queue.length > 0 ? nanoidState.queue.shift()! : random());
    },
  };
});

import {
  generateShortCode,
  isReservedShortCode,
  validateCustomSlug,
  MIN_CUSTOM_SLUG_LENGTH,
  MAX_CUSTOM_SLUG_LENGTH,
  RESERVED_ROUTES,
} from "../../src/utils/short-code";
import { createApp } from "../../src/router";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * A route path that occupies exactly one URL segment and names a literal
 * destination: `/dashboard`. Parameterised (`/:code`, `/r/:tenant/:code`) and
 * multi-segment (`/api/links`) paths are excluded on purpose — those can never
 * be shadowed by a one-segment short code, so demanding they be reserved would
 * be wrong, not strict.
 */
const SINGLE_SEGMENT_LITERAL = /^\/[A-Za-z0-9-]+$/;

/**
 * Single-segment route paths from the live router, as bare segment names.
 *
 * Duplicates collapse: Hono records one entry per handler in a middleware
 * chain, so the same path can appear several times.
 */
function singleSegmentAppRoutes(app: ReturnType<typeof createApp>): string[] {
  const seen = new Set<string>();
  for (const route of app.routes) {
    if (route.path === "/") continue;
    if (!SINGLE_SEGMENT_LITERAL.test(route.path)) continue;
    seen.add(route.path.slice(1));
  }
  return [...seen];
}

/**
 * Given a list of route PATHS, returns the bare names of single-segment literal
 * routes that the reserved list does not cover. An empty array is the contract:
 * every shadowable app route is protected.
 */
function reservedGaps(routePaths: string[], reserved: readonly string[] = RESERVED_ROUTES): string[] {
  const reservedSet = new Set(reserved);
  return routePaths
    .filter((p) => p !== "/" && SINGLE_SEGMENT_LITERAL.test(p))
    .map((p) => p.slice(1))
    .filter((name) => !reservedSet.has(name))
    .sort();
}

function testEnv(): any {
  return {
    SHORT_URL_DOMAIN: "short.link",
    SUPABASE_JWT_SECRET: "test-secret",
    SUPABASE_URL: "https://test.supabase.co",
    SUPABASE_ANON_KEY: "test-anon-key",
    SUPABASE_SERVICE_ROLE_KEY: "test-service-key",
    SHORT_URL_CACHE: {} as any,
    TENANT_CACHE: {} as any,
  };
}

// ---------------------------------------------------------------------------
// generateShortCode — existing alphabet/length contract
// ---------------------------------------------------------------------------

describe("generateShortCode", () => {
  beforeEach(() => {
    nanoidState.queue = [];
  });

  const EXPECTED_ALPHABET = new Set(
    "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"
  );

  it("produces a string of exactly 7 characters", () => {
    const code = generateShortCode();

    expect(code.length).toBe(7);
  });

  it("uses only characters from the defined alphabet", () => {
    // Generate multiple codes to exercise the randomness
    for (let i = 0; i < 10; i++) {
      const code = generateShortCode();
      for (const char of code) {
        expect(EXPECTED_ALPHABET.has(char)).toBe(true);
      }
    }
  });

  it("does not contain ambiguous characters (0, O, I, 1, l)", () => {
    const ambiguous = new Set(["0", "O", "I", "1", "l"]);

    for (let i = 0; i < 10; i++) {
      const code = generateShortCode();
      for (const char of code) {
        expect(ambiguous.has(char)).toBe(false);
      }
    }
  });

  it("produces different codes on consecutive calls", () => {
    const code1 = generateShortCode();
    const code2 = generateShortCode();

    expect(code1).not.toBe(code2);
  });

  it("produces unique codes across many generations (collision check)", () => {
    const codes = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      codes.add(generateShortCode());
    }

    // All 1000 codes should be unique
    expect(codes.size).toBe(1000);
  });
});

// ---------------------------------------------------------------------------
// T2.1 — the generator never emits a reserved route
//
// A generated code equal to `dashboard` would be unreachable: Hono resolves the
// static /dashboard route ahead of /:code, so the link would 404 forever while
// still occupying the registry and the free-tier count.
// ---------------------------------------------------------------------------

describe("generateShortCode reserved-route guard (T2.1)", () => {
  beforeEach(() => {
    nanoidState.queue = [];
  });

  it("regenerates instead of returning a reserved route", () => {
    for (const reserved of RESERVED_ROUTES) {
      // Reserved on the first draw, usable on the second.
      nanoidState.queue = [reserved, "aaa1111"];
      expect(generateShortCode()).toBe("aaa1111");
    }
  });

  it("skips a run of reserved routes and returns the first usable code", () => {
    nanoidState.queue = ["login", "signup", "abc1234"];

    expect(generateShortCode()).toBe("abc1234");
  });

  it("never returns a reserved route across many generations", () => {
    const reserved = new Set<string>(RESERVED_ROUTES);

    for (let i = 0; i < 1000; i++) {
      expect(reserved.has(generateShortCode())).toBe(false);
    }
  });
});

describe("isReservedShortCode", () => {
  it("matches every reserved route", () => {
    for (const reserved of RESERVED_ROUTES) {
      expect(isReservedShortCode(reserved)).toBe(true);
    }
  });

  it("does not match a normal short code", () => {
    expect(isReservedShortCode("VHvuSpP")).toBe(false);
    expect(isReservedShortCode("abc1234")).toBe(false);
  });

  it("is case-sensitive: route matching is case-sensitive too", () => {
    expect(isReservedShortCode("Dashboard")).toBe(false);
    expect(isReservedShortCode("LOGIN")).toBe(false);
  });

  it("does not match a multi-segment path or a prefixed variant", () => {
    // These are different URLs and do not collide with /:code.
    expect(isReservedShortCode("api/links")).toBe(false);
    expect(isReservedShortCode("auth/callback")).toBe(false);
    expect(isReservedShortCode("x-dashboard")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// T2.2 — the reserved list cannot drift from the actual router
//
// The failure this exists to prevent is specific and silent: someone adds
// `app.get("/settings", settingsHandler)` and nothing breaks. The route resolves,
// `/:code` never sees it, and every generated code equal to "settings" is dead
// on arrival. Nothing fails until someone happens to generate that code.
//
// Deriving the expected set from `createApp(...).routes` is what makes the test
// a guard rather than a restatement of the constant.
// ---------------------------------------------------------------------------

describe("reserved routes cover the real router (T2.2)", () => {
  it("reserves every single-segment route registered in src/router.ts", () => {
    const app = createApp(testEnv());
    const appRoutes = app.routes.map((r) => r.path);

    // Sanity: the derivation actually found the routes. Without this, an empty
    // result would make the assertion below vacuously true.
    expect(appRoutes.length).toBeGreaterThan(0);
    expect(singleSegmentAppRoutes(app)).toContain("dashboard");

    expect(reservedGaps(appRoutes)).toEqual([]);
  });

  it("registers no reserved route that does not exist in the router", () => {
    const app = createApp(testEnv());
    const appRoutes = new Set(singleSegmentAppRoutes(app));

    // Guards the other direction: a stale entry left behind after a rename is
    // a route that could never be generated but still constrains the generator.
    const orphans = RESERVED_ROUTES.filter((r) => !appRoutes.has(r));
    expect(orphans).toEqual([]);
  });

  it("would report a newly added single-segment app route as a gap", () => {
    // The guard's own failure mode, asserted directly: a route that exists in
    // the router but not in the reserved list is reported, so registering an app
    // route without updating src/utils/short-code.ts fails this suite.
    const routes = ["/", "/login", "/dashboard", "/settings", "/api/links", "/:code", "/r/:tenant/:code"];

    expect(reservedGaps(routes)).toEqual(["settings"]);
  });

  it("does not require multi-segment or parameterised routes to be reserved", () => {
    // /:code is the catch-all itself, and multi-segment paths cannot be
    // shadowed by a one-segment short code.
    const routes = ["/", "/auth/callback", "/api/links", "/api/links/:id", "/:code", "/r/:tenant/:code"];

    expect(reservedGaps(routes)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// T3.2 — caller-supplied slug validation
//
// THE CONSTRAINT THIS EXISTS FOR: one NFC tag or QR sticker per physical
// location, printed once, living in the world for months. Nothing about that
// URL can change afterwards without re-printing every sticker. So a supplied
// slug is not a suggestion the system may adjust — it is the literal string
// that will be embossed on a tag, and every rule below exists to reject a value
// that could not possibly work once printed.
//
// Note the asymmetry with generateShortCode, which REGENERATES on a bad draw.
// That is correct there because the user did not choose the code. Here the user
// chose it, and substituting anything would produce stickers pointing at
// somebody else's link.
// ---------------------------------------------------------------------------

describe("validateCustomSlug", () => {
  /** Asserts a slug is rejected, and returns the failure for further checks. */
  function expectRejected(slug: unknown) {
    const result = validateCustomSlug(slug);
    expect(result.valid).toBe(false);
    if (result.valid) throw new Error("expected rejection");
    return result;
  }

  it("accepts a typical physical-location slug", () => {
    expect(validateCustomSlug("cafe-central").valid).toBe(true);
  });

  it("accepts every character class the alphabet permits", () => {
    // Upper, lower, digit, underscore, hyphen — all in one value, because a
    // rule that only ever sees `cafe-central` is not a rule.
    expect(validateCustomSlug("Cafe_Central-01").valid).toBe(true);
  });

  it("accepts both length boundaries exactly", () => {
    expect(MIN_CUSTOM_SLUG_LENGTH).toBe(3);
    expect(MAX_CUSTOM_SLUG_LENGTH).toBe(32);
    expect(validateCustomSlug("a" + "b".repeat(1) + "c" /* 3 */).valid).toBe(true);
    expect(validateCustomSlug("a".repeat(32)).valid).toBe(true);
  });

  it("rejects one character below the minimum and one above the maximum", () => {
    expectRejected("ab");
    expectRejected("a".repeat(33));
  });

  it("rejects a non-string outright rather than coercing it", () => {
    // A number 12345 would stringify to a valid-looking slug. Coercing would
    // hand back a value the caller never typed as the literal for a printed tag.
    expectRejected(12345);
    expectRejected(null);
    expectRejected(undefined);
    expectRejected(["cafe"]);
    expectRejected({ slug: "cafe" });
  });

  it("rejects a slash, which would break the single-segment route", () => {
    const result = expectRejected("cafe/central");
    expect(result.code).toBe("invalid_slug_charset");
  });

  it("rejects spaces and punctuation outside the permitted alphabet", () => {
    for (const bad of ["cafe central", "cafe.central", "café", "cafe!", "a b", "%2F"]) {
      expectRejected(bad);
    }
  });

  it("rejects a leading hyphen so it does not read like a flag", () => {
    const result = expectRejected("-cafe");
    expect(result.code).toBe("invalid_slug_hyphen");
  });

  it("rejects a trailing hyphen too", () => {
    const result = expectRejected("cafe-");
    expect(result.code).toBe("invalid_slug_hyphen");
  });

  /**
   * D2 — a reserved slug is an UNREACHABLE link, not an unlucky draw.
   *
   * Hono resolves a registered static route ahead of `/:code`, so `dashboard`
   * as a short code is shadowed by the dashboard page: the link 404s forever
   * while still consuming a registry row and a quota slot. Rejecting is the
   * only honest outcome — the user must be told, at creation time, while the
   * stickers are still unmade.
   */
  it("rejects every reserved route and NAMES IT in the message", () => {
    for (const reserved of RESERVED_ROUTES) {
      const result = expectRejected(reserved);
      expect(result.code).toBe("reserved_slug");
      // The message must name the offending route, so the user can see which
      // word is unavailable rather than guessing at "invalid slug".
      expect(result.message).toContain(reserved);
    }
  });

  it("stays case-sensitive against reserved routes, matching Hono's path matching", () => {
    // `Dashboard` does NOT shadow `/dashboard`: Hono matches paths
    // case-sensitively, so this slug is genuinely free and rejecting it would
    // needlessly cost the user a printable name.
    expect(validateCustomSlug("Dashboard").valid).toBe(true);
    expect(validateCustomSlug("LOGIN").valid).toBe(true);
  });

  it("does not reject a slug merely containing a reserved word", () => {
    // Only an EXACT match collides. These are different one-segment paths.
    expect(validateCustomSlug("my-dashboard").valid).toBe(true);
    expect(validateCustomSlug("dashboard2").valid).toBe(true);
    expect(validateCustomSlug("loginpage").valid).toBe(true);
  });
});
