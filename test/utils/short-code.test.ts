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
