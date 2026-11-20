import { describe, it, expect } from "vitest";
import { dashboardHandler } from "../../src/handlers/dashboard";
import { inlineScripts } from "../helpers/inline-scripts";

// ---------------------------------------------------------------------------
// The served dashboard page.
//
// Most of the dashboard is built client-side by the inline <script> this
// handler serves, so these tests extract the real functions out of the SERVED
// output and execute them. Asserting against a hand-copied copy would pass
// while the shipped code stayed broken.
//
// Sections that moved to React islands (odd/tasks/dashboard-react.md) are
// tested as components in web/test instead: the Links section (table, create
// form, bulk cards, QR modal) and the print queue in web/test/links and
// web/test/print-queue.test.ts (T3a/T3b); the Overview section (print
// button, satisfaction panel, busy hours, client rollup) in web/test/overview
// (T4); Businesses, Comments and Settings, with the branches store they
// share, in web/test/businesses, web/test/comments, web/test/settings and
// web/test/branches (T5). What stays here is the served shell: the mount
// points, the first paint, the auth bootstrap, the tenant picker and the
// sidebar routing.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Helpers: mock Hono context
// ---------------------------------------------------------------------------

function mockContext() {
  return {
    env: {
      SUPABASE_URL: "https://test.supabase.co",
      SUPABASE_ANON_KEY: "test-anon-key",
    },
    html: (body: string) =>
      new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      }),
  } as any;
}

/** Serves `GET /dashboard` and returns the raw response body. */
async function serve(): Promise<string> {
  const response = await dashboardHandler(mockContext());
  return response.text();
}

/**
 * A statement only the dashboard's own inline <script> block carries (the
 * readiness gate it creates). The shell's other inline block is the Supabase
 * auth bootstrap, which resolves the gate but never creates it.
 */
const CLIENT_SCRIPT_MARKER = "window.__apiReady = new Promise";

/** Returns the dashboard's own inline <script> block. */
async function clientScript(): Promise<string> {
  const html = await serve();
  const script = inlineScripts(html)[0];
  if (!script || !script.includes(CLIENT_SCRIPT_MARKER)) {
    throw new Error("dashboard client script not found in served HTML");
  }
  return script;
}


/**
 * The served script with its COMMENTS removed.
 *
 * Added after a negative assertion (`not.toContain("original_url:")`) failed
 * because the comment directly above it explained the rule and contained the
 * word. It was the third time in this file a substring assertion caught its own
 * prose — the first was `data-action`, the second a test name.
 *
 * The failure mode is nasty precisely because it looks like a real finding: the
 * assertion reports a violation of a rule, and the violation is the test's own
 * documentation of that rule. Stripping comments first makes a negative
 * assertion mean what it says — about the CODE.
 */
function codeOnly(script: string): string {
  return script
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

/** Markup with its HTML comments removed, so a test reads only the elements. */
function codeOnlyHtml(html: string): string {
  let previous: string;
  let current = html;
  do {
    previous = current;
    current = current.replace(/<!--[\s\S]*?-->/g, "");
  } while (current !== previous);
  return current;
}

/** Extracts a named `function foo(...) {...}` by brace matching. */
function extractFunction(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name}() not found`);
  let depth = 0;
  for (let i = src.indexOf("{", start); i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unterminated ${name}()`);
}

/** Compiles a named client-side function out of the SERVED script. */
async function loadClientFunction<T>(name: string): Promise<T> {
  const src = extractFunction(await clientScript(), name);
  return new Function(`${src}\nreturn ${name};`)() as T;
}

// ---------------------------------------------------------------------------
// Shell contract
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Shell contract
// ---------------------------------------------------------------------------

describe("dashboardHandler shell", () => {
  it("serves HTML with a text/html content type", async () => {
    const response = await dashboardHandler(mockContext());

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/html");
  });

  it("serves the Links section's content as the React island's mount point, titled before the bundle runs", async () => {
    const html = await serve();

    // The <section> stays server-rendered (showSection and the print rules
    // act on it); everything inside it is the island's.
    expect(html).toMatch(
      /<section class="dash-section" data-section="links">\s*<!--[\s\S]*?-->\s*<div id="links-root" data-island="links" data-link-limit="\d+">\s*<div class="card no-print" id="links-card">/,
    );
    expect(html).toContain("Your Links");
    // The table itself is the island's (web/src/links); the server ships none.
    expect(html).not.toContain('id="links-table"');
    expect(html).not.toContain('id="links-body"');
  });

  it("serves no Links markup the island now draws: no create form, no bulk or QR modal", async () => {
    const html = await serve();

    // web/test/links/create.test.tsx, bulk.test.tsx and qr.test.tsx pin them.
    for (const id of ["create-form", "url", "slug", "gated", "create-msg", "result", "short-url", "open-bulk", "bulk-modal", "bulk-count", "bulk-label", "bulk-gated", "qr-modal", "qr-img", "qr-url", "copy-print-sheet"]) {
      expect(html, id).not.toContain(`id="${id}"`);
    }
    // And with them went the last inline handlers: an attribute body is
    // handed to the JS engine, where HTML entities terminate nothing.
    expect(html).not.toMatch(/<[^>]+\sonclick=/i);
  });
});

describe("landing handler (confirmation)", () => {
  it("interpolates no request-scoped or user data into the page", async () => {
    const { landingHandler } = await import("../../src/handlers/landing");
    const response = await landingHandler({
      env: { SUPABASE_URL: "https://test.supabase.co", SUPABASE_ANON_KEY: "k" },
      req: {},
    } as any);
    const html = await response.text();

    // The only interpolations are deployment config (Supabase URL/key).
    // No stored record, header value, or query parameter reaches this page.
    const interpolations = [...html.matchAll(/\$\{[^}]*\}/g)].map((m) => m[0]);
    expect(interpolations).toEqual([]);
    expect(html).not.toMatch(/\bon(click|error|load)\s*=\s*["'][^"']*\$/);
  });
});
// ---------------------------------------------------------------------------
// Phase 2 — visitor figures, and the caveat that qualifies them
//
// Two independent requirements, deliberately tested separately:
//
//   1. `unique_visitors` and `sessions` are rendered with EQUAL WEIGHT. The
//      user rejected a hierarchy between them, and a hierarchy is exactly the
//      kind of thing that sneaks back in through styling, so the assertion is
//      on the markup shape rather than on a class name.
//   2. The caveat is visible in the RENDERED MARKUP. Not in a comment, not in
//      the README, not behind a tooltip. If it were only in the source it
//      would be true of nobody who reads the page.
// ---------------------------------------------------------------------------

import { VISITOR_ESTIMATE_CAVEAT } from "../../src/analytics/metrics";

/**
 * The part of the served page that exists WITHOUT any script running.
 *
 * Every server-rendered element sits ahead of the dashboard's inline <script>
 * — nav, the create form, the links card and the clients card. Note the
 * boundary is the inline `<script>`, NOT `<script src=`: the dashboard's own
 * script (which carries the row template, and a second copy of the caveat) is
 * rendered INSIDE the container, ahead of the shell's Supabase loader. Cutting
 * at `<script src=` therefore included script content and made every caveat
 * assertion satisfiable by text a script produces — which is precisely the
 * failure this function exists to prevent.
 */
async function staticRegion(): Promise<string> {
  const html = await serve();
  const cut = html.indexOf("<script>");
  if (cut < 0) throw new Error("inline script boundary not found in served HTML");
  return html.slice(0, cut);
}

/** The static "About visitor figures" note's text, or undefined if absent. */
async function staticCaveatText(): Promise<string | undefined> {
  return (await staticRegion()).match(
    /<p class="estimate-note"><strong>About visitor figures:<\/strong>([\s\S]*?)<\/p>/,
  )?.[1];
}

describe("visitor figures — the caveat is in the rendered markup", () => {
  it("serves the caveat as static markup, visible before any script runs", async () => {
    const text = await staticCaveatText();

    // Static server-rendered text, not something a script injects after a
    // fetch. This is the copy a store owner sees on page load.
    expect(text).toBeDefined();
    expect(text).toContain(VISITOR_ESTIMATE_CAVEAT);
  });

  it("states the actual limitation rather than gesturing at one", async () => {
    const text = await staticCaveatText();

    // A caveat that says only "figures are approximate" tells the reader
    // nothing they can act on. It has to name the cause — people sharing an
    // address — and the direction of the error — under-reporting.
    expect(text).toMatch(/same Wi-Fi or mobile network/);
    expect(text).toMatch(/counted as one visitor/i);
    expect(text).toMatch(/UNDER-report/i);
  });


  it("leaves the store-level rollup and its caveat to the Overview island", async () => {
    const region = await staticRegion();

    // The rollup card, with the same caveat beside it, is drawn by the island
    // (web/test/overview/overview.test.tsx pins the caveat there). The server
    // serves only the mount point inside the overview section.
    expect(region).not.toContain('id="clients-card"');
    expect(region).toMatch(
      /<section class="dash-section" data-section="overview" hidden>[\s\S]*?<div id="overview-root" data-island="overview"><\/div>\s*<\/section>/,
    );
  });
});

describe("printable report", () => {
  async function printCss(): Promise<string> {
    const html = await serve();
    const start = html.indexOf("@media print {");
    expect(start).toBeGreaterThan(-1);
    // The block ends at the first line that closes it at the same indentation.
    return html.slice(start, html.indexOf("\n    }\n", start));
  }

  it("hides navigation, the admin column, controls and the links table when printed", async () => {
    const css = await printCss();

    expect(css).toContain(".topbar,");
    expect(css).toContain(".sidebar,");
    expect(css).toContain('.dash-section:not([data-section="overview"]),');
    expect(css).toContain(".no-print,");
    expect(css).toContain("button,");
    expect(css).toContain("select,");
    expect(css).toContain("display: none !important;");
  });

  it("keeps each card on one page and prints the bar colours", async () => {
    const css = await printCss();

    expect(css).toContain("break-inside: avoid;");
    expect(css).toContain("print-color-adjust: exact;");
  });

  it("marks the links table as not part of the report", async () => {
    const html = await serve();

    // The print button is the Overview island's (web/test/overview).
    expect(html).toMatch(/<div class="card no-print" id="links-card"[^>]*>/);
  });

  it("keeps the report keyed on the server-rendered overview section the island mounts inside", async () => {
    const html = await serve();
    const css = await printCss();

    expect(css).toContain('.dash-section[data-section="overview"] { display: block !important; }');
    expect(css).toContain('body.printing-cards .dash-section[data-section="overview"] { display: none !important; }');
    expect(html).toMatch(/data-section="overview" hidden>[\s\S]*?<div id="overview-root" data-island="overview">/);
  });
});

// ---------------------------------------------------------------------------
// The auth bootstrap and the readiness gate
//
// The dashboard serves TWO inline scripts and they do not run in a
// cooperative order:
//
//   <script>  (container)   creates window.__apiReady, wires the page
//   <script src=...supabase>
//   <script>  (shell)       async IIFE -> await sb.auth.getSession()
//                           -> defines window.__api -> resolves the gate
//   <script type=module>    the React islands; the Links island awaits the
//                           gate, then loads (web/test/links/loading.test.tsx)
//
// The shell bootstrap suspends on a network round-trip, so anything that runs
// before it resolves finds no window.__api. Loading the links at parse time
// once rendered "Could not load links. window.__api is not a function".
// ---------------------------------------------------------------------------

type ElementStub = {
  style: { display: string };
  textContent: string;
  innerHTML: string;
  dataset: Record<string, unknown>;
  addEventListener: (type: string, handler: unknown) => void;
};
function stubElement(): ElementStub {
  return {
    style: { display: "" },
    textContent: "",
    innerHTML: "",
    dataset: {},
    addEventListener: () => {},
  };
}

/**
 * Executes the served shell auth bootstrap against a stub window, so the
 * redirect path and the resolve ordering are observed rather than assumed.
 * `session: null` is the unauthenticated visitor.
 */
async function runAuthBootstrap(session: unknown) {
  const html = await serve();
  const start = html.indexOf("<script src=");
  if (start < 0) throw new Error("auth bootstrap not found in served HTML");
  const end = html.indexOf("})();", start);
  if (end < 0) throw new Error("auth bootstrap is not terminated in served HTML");
  const iife = html.slice(html.indexOf("(async () => {", start), end + 5);

  let resolveCalls = 0;
  let apiTypeAtResolve = "<never called>";
  const win: Record<string, any> = {
    location: { href: "" },
    supabase: {
      createClient: () => ({ auth: { getSession: async () => ({ data: { session } }) } }),
    },
  };
  // Pre-installed so the bootstrap finds one whichever order it is written in.
  // The bootstrap itself never defines it — only the container script does.
  win.__apiReadyResolve = () => {
    resolveCalls++;
    apiTypeAtResolve = typeof win.__api;
  };

  await new Function("window", "document", `return ${iife}`)(win, {
    getElementById: stubElement,
  });

  return {
    win,
    resolveCalls: () => resolveCalls,
    apiTypeAtResolve: () => apiTypeAtResolve,
  };
}

describe("the dashboard script never triggers a load at parse time", () => {
  it("makes no request at all: every load belongs to an island", async () => {
    const script = codeOnly(await clientScript());

    // Each section's island awaits the gate and loads itself (web/test/*);
    // a call here would run before the session resolved and before
    // window.__api existed.
    expect(script).not.toContain("window.__api(");
    expect(script).not.toMatch(/\bload[A-Z]\w*\(/);
    expect(script).not.toContain("__loadLinks");
  });

  it("creates the readiness gate in the container script, before the auth script", async () => {
    const html = await serve();

    const gateAt = html.indexOf("window.__apiReady = new Promise");
    const authAt = html.indexOf("<script src=");
    expect(gateAt).toBeGreaterThan(-1);
    // If the gate were created after the bootstrap script, a parse-time caller
    // would find it undefined and the race would come straight back.
    expect(gateAt).toBeLessThan(authAt);
  });
});

describe("the auth bootstrap gates its own load", () => {
  it("resolves the gate only after window.__api exists", async () => {
    const { resolveCalls, apiTypeAtResolve, win } = await runAuthBootstrap({
      access_token: "tok",
      user: { email: "owner@example.com" },
    });

    expect(win.location.href).toBe("");
    expect(typeof win.__api).toBe("function");
    expect(resolveCalls()).toBe(1);
    // Ordering, observed: a resolver that ran before __api existed would
    // release every waiter onto the same race.
    expect(apiTypeAtResolve()).toBe("function");
  });

  it("opens the gate after defining the helper, and starts no load of its own", async () => {
    const html = await serve();
    const auth = html.slice(html.indexOf("<script src="));
    const iife = codeOnly(auth.slice(0, auth.indexOf("})();")));

    // The islands load themselves once the gate opens, the branches store
    // included (web/test/branches/store.test.ts); a call here too would load
    // them twice.
    const resolveAt = iife.indexOf("window.__apiReadyResolve?.()");
    const helperAt = iife.indexOf("window.__api = async");
    expect(helperAt).toBeGreaterThan(-1);
    expect(resolveAt).toBeGreaterThan(helperAt);
    for (const fn of ["loadLinks", "loadBranches", "loadFeedbackEmail", "loadFeedbackInbox", "loadHourlyTraffic"]) {
      expect(iife, fn).not.toContain(fn);
    }
  });

  it("redirects without opening the gate or defining the api helper", async () => {
    const { win, resolveCalls } = await runAuthBootstrap(null);

    expect(win.location.href).toBe("/login");
    expect(win.__api).toBeUndefined();
    // The page is navigating away. Releasing the gate here would only start a
    // load that cannot succeed, so the unauthenticated path leaves every waiter
    // parked — nothing to render, nothing to fetch.
    expect(resolveCalls()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Multi-location switcher
//
// The API answers 409 tenant_required when a user holds several memberships and
// names none — it refuses rather than guessing, because guessing was the bug
// Phase 4 removed. Until this shipped, such a user got an error instead of a
// dashboard. It is the last known broken path in the product.
// ---------------------------------------------------------------------------

describe("dashboard — tenant switcher", () => {
  // Read the HTML the server actually serves, not the handler's source: these
  // assertions are about what the browser receives.
  async function script(): Promise<string> {
    return serve();
  }

  it("sends the selected location on every API call", async () => {
    expect(await script()).toContain("X-Tenant-Slug");
  });

  it("remembers the choice, so a refresh does not fall back to 409", async () => {
    // The failure mode this exists to prevent: the user picks a location, the
    // page reloads, the selection is gone, and they are back at an error.
    expect(await script()).toContain('localStorage.setItem("tenant"');
    expect(await script()).toContain('localStorage.getItem("tenant")');
  });

  // A shared dashboard link should open the store it names, without the user
  // re-picking it on every visit.
  it("prefers a tenant named in the URL over the remembered one", async () => {
    expect(await script()).toContain("URLSearchParams");
  });

  it("handles 409 and renders the picker", async () => {
    const src = await script();
    expect(src).toContain("res.status === 409");
    expect(src).toContain("tenant_required");
    expect(src).toContain("__showTenantPicker");
  });

  it("shows which role the user holds in that location", async () => {
    // Admin and viewer mean different permissions. A switcher showing only
    // names would let someone pick a store they can see but not manage, and
    // then find out at the worst moment.
    expect(await script()).toContain("t.role");
  });

  // __api calls the picker synchronously on a 409, and the boot loads run at
  // the end of the same IIFE. Defined later, it is undefined at the moment of call.
  it("defines the picker before any API call can reach it", async () => {
    const src = await script();
    expect(src.indexOf("__showTenantPicker = function")).toBeGreaterThan(-1);
    // Both markers are asserted to exist by the tests above, so this compares
    // two real offsets rather than two -1s.
    const defined = src.indexOf("__showTenantPicker = function");
    const called = src.indexOf("__showTenantPicker(payload.available)");
    expect(defined).toBeGreaterThan(-1);
    expect(called).toBeGreaterThan(-1);
    expect(defined).toBeLessThan(called);
  });

  // The business name comes from the API, so it is untrusted markup.
  it("escapes a location name that contains markup", async () => {
    expect(await script()).toContain('.replace(/[<>&]/g, "")');
  });

  it("does not break the single-location user who never sees the picker", async () => {
    // One membership resolves server-side with no header, so nothing here may
    // become a precondition for the dashboard loading at all.
    expect(await script()).toContain("if (q) headers[");
  });
});

// ---------------------------------------------------------------------------
// The api helper's auth contract
//
// The Links island's requests (bulk cards and their print sheet included,
// web/test/links/bulk.test.tsx) all go through window.__api, so the helper
// itself has to keep carrying the whole contract.
// ---------------------------------------------------------------------------

describe("the api helper", () => {
  it("carries the bearer token and the tenant on every request", async () => {
    // Asserted against the WHOLE served page: __api lives in the shell's
    // bootstrap block, not in clientScript().
    const html = await serve();

    expect(html).toContain("Bearer " + '" + window.__token');
    expect(html).toContain('headers["X-Tenant-Slug"] = q');
  });
});

describe("the served client script parses", () => {
  /**
   * The test that was missing, added after shipping a dead dashboard.
   *
   * Every other assertion in this file compares SUBSTRINGS. Substrings match
   * happily inside a script the browser cannot parse, so a hundred green
   * assertions once coexisted with `Uncaught SyntaxError: Invalid or unexpected
   * token` and a dashboard that did nothing at all.
   *
   * `new Function` COMPILES without EXECUTING. Nothing in this script runs: no
   * fetch, no DOM access, no auth. It is a parser, not a smoke test — which is
   * what makes it safe to run on the whole block on every test run.
   */
  it("is valid JavaScript", async () => {
    const html = await serve();
    const blocks = inlineScripts(html);
    const client = blocks.find((b) => b.includes(CLIENT_SCRIPT_MARKER));
    expect(client).toBeDefined();

    let error: unknown = null;
    try {
      new Function(client!);
    } catch (e) {
      error = e;
    }
    expect(error, String(error)).toBeNull();
  });

  it("emits no raw newline inside a string literal", async () => {
    // The specific escape that broke it.
    //
    // The client script is a TEMPLATE LITERAL in the handler, so a `\n` written
    // in that source becomes a REAL newline in the served JavaScript. Real
    // newlines inside a double-quoted string are a SyntaxError. The prompt text
    // needed `\\n` in the handler so the browser receives the two-character
    // escape and renders a line break at runtime.
    //
    // Asserted here because it is invisible in review: the handler compiles, the
    // typecheck passes, and every substring assertion still matches. Only the
    // parser sees it.
    //
    // The prompt that carried that escape was replaced by an inline field
    // (odd/tasks/business-branches.md, S4). What remains true: no escaped
    // newline in the handler may reach the browser as a real one inside a
    // string. The parse test above is what proves it for the whole block; this
    // one pins that no window.prompt with multi-line text came back.
    const html = await serve();
    const blocks = inlineScripts(html);
    const client = blocks.find((b) => b.includes(CLIENT_SCRIPT_MARKER))!;

    expect(client).not.toMatch(/window\.prompt\("[^"]*\n/);
  });
});

// ---------------------------------------------------------------------------
// The review-screen checkbox (odd/tasks/review-screen-refresh.md, S1)
//
// `is_gated` decides whether a scan shows the review screen or goes straight
// to the destination. Unchecked is the default everywhere.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Full-width layout (odd/tasks/review-screen-refresh.md, S5)
//
// The page used to be a single 720px column centred in the window. It now uses
// the width: a main column for what the owner reads, a side column for what
// they configure, stacked on a phone.
// ---------------------------------------------------------------------------

describe("sidebar sections (odd/tasks/print-queue-cards.md S1)", () => {
  /** The markup of one <section data-section="..."> block. */
  function section(html: string, name: string): string {
    const start = html.indexOf(`<section class="dash-section" data-section="${name}"`);
    expect(start, `${name} section is missing`).toBeGreaterThan(-1);
    return html.slice(start, html.indexOf("</section>", start));
  }

  it("no longer caps the page at a 720px column", async () => {
    const html = await serve();
    expect(html).not.toContain("max-width: 720px");
    expect(html).toMatch(/\.container\s*\{[^}]*max-width:\s*1440px/);
  });

  it("lists the six sections in the sidebar, in order", async () => {
    const html = await serve();
    const nav = html.slice(html.indexOf('<aside class="sidebar'), html.indexOf("</aside>"));
    // Each link is an icon followed by its label in a <span>.
    const links = [...nav.matchAll(/<a href="#([a-z]+)" data-section-link="\1"[^>]*>[^]*?<span>([^<]+)<\/span>/g)].map((m) => [m[1], m[2]!.trim()]);
    expect(links).toEqual([
      ["overview", "Overview"],
      ["links", "Links"],
      ["cards", "Cards"],
      ["businesses", "Businesses and branches"],
      ["comments", "Comments"],
      ["settings", "Settings"],
    ]);
  });

  it("puts the sidebar beside the sections on a wide screen", async () => {
    const html = await serve();
    expect(html).toMatch(/@media \(min-width: 1024px\)\s*\{\s*\.app\s*\{[^}]*grid-template-columns/);
  });

  it("groups the existing cards into their sections", async () => {
    const html = await serve();
    // The Overview's print button and report cards are its island's
    // (web/test/overview); the server serves the mount point.
    expect(section(html, "overview")).toContain('<div id="overview-root" data-island="overview">');
    const links = section(html, "links");
    // The whole section's content is the Links island's (create form, bulk
    // cards, table, QR modal); the server paints the table card first.
    expect(links).toContain('<div id="links-root" data-island="links"');
    expect(links).toContain('id="links-card"');
    expect(section(html, "cards")).toContain('id="cards-root"');
    // Their cards (#businesses-card, #feedback-card, #feedback-email-card)
    // are the islands' (web/test/businesses, comments, settings).
    expect(section(html, "businesses")).toContain('<div id="businesses-root" data-island="businesses">');
    expect(section(html, "comments")).toContain('<div id="comments-root" data-island="comments">');
    expect(section(html, "settings")).toContain('<div id="settings-root" data-island="settings">');
  });

  it("shows only one section at a time, starting hidden except Links", async () => {
    const html = await serve();
    const tags = [...html.matchAll(/<section class="dash-section" data-section="([a-z]+)"( hidden)?>/g)].map(
      (m) => [m[1], Boolean(m[2])],
    );
    expect(tags).toEqual([
      ["overview", true],
      ["links", false],
      ["cards", true],
      ["businesses", true],
      ["comments", true],
      ["settings", true],
    ]);
  });

  it("reads the section from the URL hash and falls back to Links", async () => {
    const fromHash = await loadClientFunction<(h: string) => string>("sectionFromHash");

    expect(fromHash("#cards")).toBe("cards");
    expect(fromHash("#overview")).toBe("overview");
    expect(fromHash("")).toBe("links");
    expect(fromHash("#nope")).toBe("links");
    expect(codeOnly(await clientScript())).toContain('addEventListener("hashchange"');
  });
});

// ---------------------------------------------------------------------------
// The Cards section (odd/tasks/print-queue-cards.md S4-S6); the print queue
// itself is pinned in web/test/print-queue.test.ts.
// ---------------------------------------------------------------------------

describe("cards section", () => {
  function cardsSection(html: string): string {
    const start = html.indexOf('<section class="dash-section" data-section="cards"');
    return html.slice(start, html.indexOf("</section>", start));
  }

  it("hands the section to the React island (web/src/cards), with no server-rendered controls", async () => {
    const section = cardsSection(await serve());
    const script = codeOnly(await clientScript());

    expect(section).toContain('<div class="card" id="cards-root" data-island="cards"></div>');
    for (const id of ["card-sheet", "card-sheets", "cards-controls", "cards-export", "cards-mark-printed"]) {
      expect(section).not.toContain(`id="${id}"`);
    }
    for (const fn of ["renderCardSheets", "exportCards", "markCardsPrinted", "cardOptions", "computeSheetLayout"]) {
      expect(script).not.toContain(`function ${fn}(`);
    }
  });

  it("starts the grid at the top-left margin instead of centring it", async () => {
    const html = await serve();

    expect(html).toMatch(/\.card-sheet\s*\{[^}]*justify-content:\s*start;[^}]*align-content:\s*start;/);
    expect(html).not.toMatch(/\.card-sheet\s*\{[^}]*justify-content:\s*center/);
  });

  it("zooms only the sheets, so the empty-queue message keeps its normal size", async () => {
    const html = await serve();

    expect(html).toMatch(/\.card-sheet\s*\{[^}]*zoom:\s*var\(--card-zoom\);/);
    expect(html).not.toMatch(/#card-sheets\s*\{[^}]*zoom:\s*var\(--card-zoom\)/);
    expect(html).toMatch(/body\.printing-cards \.card-sheet\s*\{[^}]*zoom:\s*1 !important;/);
  });

  it("draws the cut guides above the card, so a mirrored card cannot hide them", async () => {
    const html = await serve();

    // An outline on the card sits under the SVG's own composited layer once
    // the mirror transform promotes it; the guides are an overlay instead.
    expect(html).toMatch(/\.print-card\s*\{[^}]*position:\s*relative;/);
    expect(html).toMatch(/\.print-card\.is-crop::after\s*\{[^}]*position:\s*absolute;/);
    expect(html).toMatch(/\.print-card\.is-crop::after\s*\{[^}]*z-index:\s*2;/);
    expect(html).toMatch(/\.print-card\.is-crop::after\s*\{[^}]*border:\s*0\.25mm dashed var\(--ink-faint\);/);
    expect(html).not.toMatch(/\.print-card\.is-crop\s*\{[^}]*outline:/);
  });

  it("takes the card size from the layout, so no sheet can grow a card past 10×10 cm", async () => {
    const html = await serve();

    expect(html).toMatch(/\.print-card\s*\{[^}]*width:\s*var\(--card-size\);/);
    expect(html).toMatch(/\.print-card\s*\{[^}]*height:\s*var\(--card-size\);/);
    expect(html).toMatch(/:root\s*\{[^}]*--card-size:\s*100mm;/);
  });

  it("lines radio options up like the checkboxes", async () => {
    const html = await serve();

    expect(html).toMatch(/\.check-row input\[type="checkbox"\],\s*\.check-row input\[type="radio"\]\s*\{[^}]*width:\s*1\.125rem;/);
  });

  it("greys out a disabled outline button instead of red text on grey", async () => {
    const html = await serve();

    expect(html).toMatch(/\.btn-outline:disabled\s*\{[^}]*background:\s*transparent;[^}]*color:\s*var\(--ink-faint\);/);
  });

  it("prints only the sheets, at the sheet size, without the preview zoom", async () => {
    const html = await serve();

    expect(html).toContain("body.printing-cards");
    expect(html).toMatch(/body\.printing-cards #card-sheets\s*\{[^}]*zoom:\s*1 !important;/);
    expect(html).toMatch(/\.card-sheet \+ \.card-sheet\s*\{[^}]*break-before:\s*page;/);
  });

  it("keeps the queue itself in the page", async () => {
    const script = codeOnly(await clientScript());

    expect(script).not.toContain("/api/links/print-queue");
    expect(script).not.toContain("/api/links/printed");
    expect(script).not.toContain("print_queued: queued");
  });

  it("loads the fonts the cards are drawn with, so the PDF embeds what the preview shows", async () => {
    const html = await serve();

    expect(html).toContain('href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&amp;family=Outfit:wght@400;500;600;700&amp;display=swap"');
  });
});

describe("React islands bundle", () => {
  it("loads the bundle as a module after the page's own scripts", async () => {
    const html = await serve();
    const tag = '<script type="module" src="/assets/dashboard.js"></script>';

    expect(html).toContain(tag);
    // After the auth bootstrap, the last classic script on the page.
    expect(html.indexOf(tag)).toBeGreaterThan(html.lastIndexOf("})();"));
    expect(html.indexOf(tag)).toBeLessThan(html.indexOf("</body>"));
  });
});

// ---------------------------------------------------------------------------
// The Links island handoff (odd/tasks/dashboard-react.md T3a)
//
// The table, its row actions and the print queue are React now; their
// behaviour is pinned in web/test/links and web/test/print-queue.test.ts.
// These pin the served side of the seam: the legacy code is gone, and the
// bridges the island calls exist and do what it relies on.
// ---------------------------------------------------------------------------

describe("Links island handoff", () => {
  it("removes every legacy Links function that moved to the island", async () => {
    const script = codeOnly(await clientScript());

    for (const fn of [
      "onLinksTableClick", "renderLinkRow", "loadLinks", "renderVisitors", "repaintLink", "toggleLink",
      "setGated", "saveClientRef", "saveDestination", "saveBranch", "fillBranchSelects", "openEditor",
      "showMetrics", "deleteLink", "copyUrl", "setPrintQueued", "showQueuedState", "syncPrintQueue",
      "renderPrintQueue", "clearPrintQueue", "showQR",
    ]) {
      expect(script, fn).not.toMatch(new RegExp(`function ${fn}\\(`));
    }
    // No record-action switch either: the row actions are the island's own
    // controls (web/test/links/rows.test.tsx pins which ones a row offers).
    expect(script).not.toMatch(/case "(copy|qr|metrics|edit|save-client-ref|save-destination|save-branch|toggle|toggle-gate|delete|queue-print|unqueue-print)":/);
    // The queue is the bundle's (web/src/print-queue.ts) and the page never
    // sets it, so the two cannot disagree.
    expect(script).not.toMatch(/window\.__printQueue\s*=/);
    expect(script).not.toContain("__setPrintQueued =");
    expect(script).not.toContain("__clearPrintQueue =");
    expect(script).not.toContain("__syncPrintQueue");
  });

  it("keeps the queue in the page: neither side ever calls the print-queue endpoints", async () => {
    const script = codeOnly(await clientScript());

    expect(script).not.toContain("/api/links/print-queue");
    expect(script).not.toContain("/api/links/printed");
  });

  it("no longer lends a QR modal", async () => {
    // The QR modal is the island's (web/test/links/qr.test.tsx).
    expect(codeOnly(await clientScript())).not.toContain("__showQR");
  });

  it("lends the islands nothing but the api helper and its gate", async () => {
    const script = codeOnly(await clientScript());

    // Cards and Businesses reload the table in-bundle (web/src/links/reload.ts).
    expect(script).not.toContain("__loadLinks");
    // Only the sidebar routing is left as functions.
    expect([...script.matchAll(/function (\w+)\(/g)].map((m) => m[1])).toEqual(["sectionFromHash", "showSection"]);
  });
});

// ---------------------------------------------------------------------------
// The Overview island handoff (odd/tasks/dashboard-react.md T4, L13)
//
// The print button and the three report cards are React now, each loading its
// own data; their behaviour is pinned in web/test/overview. These pin the
// served side: the mount point, and that nothing of the legacy cards is left.
// ---------------------------------------------------------------------------

describe("Overview island handoff", () => {
  it("serves the overview section as the island's empty mount point", async () => {
    const html = await serve();
    const section = html.slice(
      html.indexOf('<section class="dash-section" data-section="overview" hidden>'),
      html.indexOf('<section class="dash-section" data-section="links">'),
    );

    expect(codeOnlyHtml(section)).toMatch(/^<section[^>]*>\s*<div id="overview-root" data-island="overview"><\/div>\s*<\/section>\s*$/);
    for (const id of ["print-report", "gate-card", "gate-body", "traffic-card", "traffic-body", "clients-card", "clients-body"]) {
      expect(html, id).not.toContain(`id="${id}"`);
    }
  });

  it("removes every legacy Overview function and bridge", async () => {
    const script = codeOnly(await clientScript());

    for (const fn of ["renderClients", "renderHourlyTraffic", "loadHourlyTraffic", "refreshClientsCard"]) {
      expect(script, fn).not.toMatch(new RegExp(`function ${fn}\\(`));
    }
    expect(script).not.toContain("renderGatePanel");
    expect(script).not.toContain("__renderOverviewCards");
    expect(script).not.toContain("__refreshClientsCard");
    expect(script).not.toContain("print-report");
    // The island fetches these itself (web/test/overview/overview.test.tsx).
    expect(script).not.toContain("/api/traffic/hourly");
    expect(script).not.toContain("/api/clients/metrics");
    expect(script).not.toContain('"/api/review-gate/metrics"');
  });

  it("leaves the Overview loads out of the auth bootstrap: the island loads itself once the gate opens", async () => {
    const html = await serve();
    const auth = html.slice(html.indexOf("<script src="));
    const iife = auth.slice(0, auth.indexOf("})();"));

    expect(codeOnly(iife)).not.toContain("loadHourlyTraffic");
  });
});

// ---------------------------------------------------------------------------
// The Businesses, Comments and Settings island handoff
// (odd/tasks/dashboard-react.md T5)
//
// The businesses card, the feedback inbox with its filter and CSV export, and
// the feedback email card are React now, and the branches they share are an
// in-bundle store; their behaviour is pinned in web/test/businesses,
// web/test/comments, web/test/settings and web/test/branches. These pin the
// served side: three empty mount points, and nothing of the legacy code or
// its window bridges left.
// ---------------------------------------------------------------------------

describe("Businesses, Comments and Settings island handoff", () => {
  it.each(["businesses", "comments", "settings"])("serves the %s section as the island's empty mount point", async (name) => {
    const html = codeOnlyHtml(await serve());
    const start = html.indexOf(`<section class="dash-section" data-section="${name}" hidden>`);
    expect(start).toBeGreaterThan(-1);
    const section = html.slice(start, html.indexOf("</section>", start) + "</section>".length);

    expect(section).toMatch(
      new RegExp(`^<section[^>]*>\\s*<div id="${name}-root" data-island="${name}"><\\/div>\\s*<\\/section>$`),
    );
  });

  it("serves none of the cards the islands draw", async () => {
    const html = await serve();
    for (const id of [
      "businesses-card", "new-business-name", "add-business", "businesses-msg", "businesses-body",
      "feedback-card", "feedback-export", "feedback-filter", "feedback-export-msg", "feedback-body",
      "feedback-email-card", "feedback-email", "feedback-email-msg", "feedback-email-save",
    ]) {
      expect(html, id).not.toContain(`id="${id}"`);
    }
  });

  it("removes every legacy Businesses, Comments and Settings function", async () => {
    const script = codeOnly(await clientScript());

    for (const fn of [
      "loadBranches", "renderBusinesses", "refreshOwnership", "showBusinessesMessage", "addBusiness", "addBranch",
      "moveBranch", "setBusinessActive", "setBranchActive", "pickableBranches", "loadFeedbackInbox", "feedbackQuery",
      "fillFeedbackFilter", "exportFeedbackCsv", "loadFeedbackEmail", "esc",
    ]) {
      expect(script, fn).not.toMatch(new RegExp(`function ${fn}\\(`));
    }
    // The injected server renderer and the esbuild shim it needed are gone:
    // the inbox is a component (web/test/comments/inbox.test.tsx).
    expect(script).not.toContain("renderFeedbackInbox");
    expect(script).not.toContain("__name");
    expect(script).not.toContain("innerHTML");
    // The endpoints are the islands' now.
    for (const path of ["/api/locations", "/api/businesses", "/api/review-gate/feedback", "/api/tenant/feedback-email"]) {
      expect(script, path).not.toContain(path);
    }
  });

  it("lends no branches bridge: the lists are the bundle's store", async () => {
    const html = codeOnlyHtml(await serve());

    expect(html).not.toContain("__branches");
    expect(html).not.toContain("__businesses");
    expect(html).not.toContain("brancheschange");
    expect(html).not.toContain("__loadLinks");
  });
});
