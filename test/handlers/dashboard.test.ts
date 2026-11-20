import { describe, it, expect, vi } from "vitest";
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
// (T4). What stays here for them is the served shell: the mount point, the
// first paint, and the bridges this page lends the islands.
// ---------------------------------------------------------------------------

const XSS_URL = '<img src=x onerror=alert(1)>';

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

/** Compiles the served `esc()` helper and returns it as a callable. */
async function loadEsc(): Promise<(v: unknown) => string> {
  const src = extractFunction(await clientScript(), "esc");
  return new Function(`${src}\nreturn esc;`)() as (v: unknown) => string;
}

/**
 * Compiles a named client-side function out of the SERVED script, bound to the
 * served `esc()`. Used for the Phase 2 renderers, which are deliberately their
 * own functions rather than the shared breakdown mapper.
 */
async function loadClientFunction<T>(name: string): Promise<T> {
  const src = extractFunction(await clientScript(), name);
  const esc = await loadEsc();
  return new Function("esc", `${src}\nreturn ${name};`)(esc) as T;
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
    // handed to the JS engine, where esc()'s entities terminate nothing.
    expect(html).not.toMatch(/<[^>]+\sonclick=/i);
  });
});

// ---------------------------------------------------------------------------
// The esc() helper itself (still used by the cards this page renders)
// ---------------------------------------------------------------------------

describe("esc() helper", () => {
  const PAYLOADS: [string, string][] = [
    ["<script>alert(1)</script>", "&lt;script&gt;alert(1)&lt;/script&gt;"],
    ['"><img src=x onerror=alert(1)>', "&quot;&gt;&lt;img src=x onerror=alert(1)&gt;"],
    ["' onmouseover='alert(1)", "&#39; onmouseover=&#39;alert(1)"],
    ["a & b", "a &amp; b"],
    ["</textarea><script>", "&lt;/textarea&gt;&lt;script&gt;"],
  ];

  for (const [input, expected] of PAYLOADS) {
    it(`neutralises ${JSON.stringify(input)}`, async () => {
      const esc = await loadEsc();
      expect(esc(input)).toBe(expected);
    });
  }

  it("escapes ampersands before the entities it introduces", async () => {
    const esc = await loadEsc();
    // Escaping & last would double-encode every entity produced above.
    expect(esc("&lt;")).toBe("&amp;lt;");
  });

  it("coerces non-string input", async () => {
    const esc = await loadEsc();

    expect(esc(42)).toBe("42");
    expect(esc(0)).toBe("0");
  });
  it("renders null and undefined as empty rather than 'null'", async () => {
    const esc = await loadEsc();

    expect(esc(null)).toBe("");
    expect(esc(undefined)).toBe("");
  });
});

// ---------------------------------------------------------------------------
// landing.ts — confirm rather than assume
// ---------------------------------------------------------------------------

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
  it("reloads the Links island only from handlers, never from the script's top-level wiring", async () => {
    const script = await clientScript();

    // Matched as whole STATEMENTS. This served script indents its top-level
    // statements by exactly six spaces; every call inside a function or an
    // event handler sits deeper. A call at the parse-time indentation would
    // run before the session resolved and before window.__api existed.
    const TOP_LEVEL_INDENT = 6;
    const statements = [...script.matchAll(/^([ \t]*)if \(window\.__loadLinks\) window\.__loadLinks\(\);[ \t]*$/gm)].map(
      (m) => m[1].length,
    );

    // Only refreshOwnership (a business or branch changed) is left. The
    // create form, bulk cards, delete and the field saves live in the island
    // and reload through its own load.
    expect(statements).toHaveLength(1);
    expect(statements.every((indent) => indent > TOP_LEVEL_INDENT)).toBe(true);
    expect(codeOnly(script)).not.toMatch(/\bloadLinks\(/);
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

  it("leaves the links load to the island, and still boots the branches after the resolve", async () => {
    const html = await serve();
    const auth = html.slice(html.indexOf("<script src="));
    const iife = auth.slice(0, auth.indexOf("})();"));

    // The island loads itself once the gate opens; a call here too would load
    // the table twice.
    expect(codeOnly(iife)).not.toContain("loadLinks");
    const resolveAt = iife.indexOf("window.__apiReadyResolve?.()");
    const helperAt = iife.indexOf("window.__api = async");
    const branchesAt = iife.indexOf('if (typeof loadBranches === "function") loadBranches();');
    expect(helperAt).toBeGreaterThan(-1);
    expect(resolveAt).toBeGreaterThan(helperAt);
    expect(branchesAt).toBeGreaterThan(resolveAt);
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
// The esbuild runtime guard.
//
// `dashboard.ts` ships `renderFeedbackInbox` to the browser by inlining its source
// with `Function.prototype.toString()`. That source is NOT the source in this
// repository: the Worker is compiled by esbuild with `keepNames: true` before
// `.toString()` ever runs, and esbuild rewrites every named function inside a
// body into a `__name(fn, "fn")` statement. Those statements travel inside the
// stringified function and then execute in the page.
//
// `__name` is defined at the top of the Worker bundle — module scope — so it
// never reaches the page, and the first call throws
// `ReferenceError: __name is not defined`. The inbox silently fails to
// render. (The review-gate panel was the first function shipped this way; it
// is a React component now, web/src/overview, so it needs none of this.)
//
// The rehydration test in `feedback-inbox.test.ts` cannot catch this: Vitest runs
// the module unbundled, so `.toString()` there returns clean source and every
// helper looks self-contained. These tests reproduce the shipped, bundled
// shape instead.
// ---------------------------------------------------------------------------

describe("the dashboard declares the esbuild runtime its injected renderer calls", () => {
  /** Everything the page declares before the renderer binding — its whole scope. */
  async function panelPreamble(): Promise<string> {
    const script = await clientScript();
    const anchor = script.indexOf("const renderFeedbackInbox =");
    if (anchor < 0) throw new Error("renderFeedbackInbox binding not found");
    return script.slice(0, anchor);
  }

  /**
   * The preamble with comments stripped.
   *
   * The shipped script documents the shim at length, so a substring search for
   * `__name` matches the prose and proves nothing. Only executable code counts.
   */
  async function panelPreambleCode(): Promise<string> {
    return (await panelPreamble()).replace(/\/\*[\s\S]*?\*\//g, "");
  }

  it("declares __name before the renderer that calls it", async () => {
    expect(await panelPreambleCode()).toMatch(/\bvar __name\b/);
  });

  it("runs a renderer body carrying keepNames output", async () => {
    const preamble = await panelPreambleCode();

    // A body in the exact shape esbuild emits: a function declaration followed
    // by the __name statement that pins its name. Building it here and running
    // it there is what the browser does, one page-load later.
    //
    // Both halves go into ONE function scope on purpose. The shim is a bare
    // `var`, so like a classic <script> it lands on the global object and the
    // panel body resolves it through that. A bare `new Function` reproduces the
    // classic-script scope exactly — which is the only reason it is safe to
    // ship this pattern at all.
    // eslint-disable-next-line no-new-func
    const build = new Function(`${preamble}
      const renderFeedbackInbox = function (payload) {
        function escapeHtml(raw) { return raw; }
        __name(escapeHtml, "escapeHtml");
        return typeof escapeHtml;
      };
      return renderFeedbackInbox;
    `);

    const panel = build() as (p: unknown) => string;
    expect(panel({})).toBe("function");
  });

  it("declares the helper as a var, so the body resolves it as a global", async () => {
    // A `const` at the top of a classic script does NOT become a global
    // property, and the renderer body is a different function. `var` is what makes
    // the lookup work; this pins that choice so it is not "cleaned up" later.
    const code = await panelPreambleCode();
    expect(code).toMatch(/\bvar __name\b/);
    expect(code).not.toMatch(/\bconst __name\b/);
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

describe("the branches load feeds the Links island's pickers", () => {
  it("loads the branches at boot, beside the links", async () => {
    const html = await serve();
    expect(html).toContain('if (typeof loadBranches === "function") loadBranches();');
    expect(extractFunction(await clientScript(), "loadBranches")).toContain('"/api/locations"');
  });

  it("announces every branches load, success or not, so the island rebuilds its pickers", async () => {
    const fn = codeOnly(extractFunction(await clientScript(), "loadBranches"));
    const tail = fn.slice(fn.lastIndexOf("}", fn.lastIndexOf("}") - 1));
    expect(fn).toContain("window.__branches = ");
    expect(fn).toContain("window.__businesses = ");
    // After the try/catch, so a failed load still lets the pickers fall back.
    expect(tail).toContain('window.dispatchEvent(new Event("brancheschange"))');
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
// The feedback email section
//
// Phase A: the owner records where private customer comments should go. It is
// stored, shown and exported. NOTHING IS EMAILED.
//
// The last part is the one worth a test, because the failure is quiet: a green
// dashboard next to a field labelled "feedback email" tells an owner their
// reviews are being delivered, and they stop checking the satisfaction panel.
// ---------------------------------------------------------------------------
describe("the feedback email section", () => {
  it("exists and is labelled as storing, not sending", async () => {
    const html = await serve();

    expect(html).toContain('id="feedback-email"');
    expect(html).toContain('id="feedback-email-save"');

    // Says so where the owner will actually read it.
    expect(html).toMatch(/nothing is emailed/i);
    expect(html).toMatch(/comments still arrive in the Comments section/i);
  });

  it("names a section that exists in the sidebar", async () => {
    const html = await serve();

    // The text tells the owner where their comments still arrive. That sentence
    // only makes sense if the section it names is one click away.
    expect(html).toMatch(/data-section-link="comments">(?:<svg[^]*?<\/svg>)?<span>Comments</);
    expect(html).toContain('<section class="dash-section" data-section="comments"');
  });

  it("PUTs to the tenant-scoped endpoint", async () => {
    const script = await clientScript();
    expect(script).toContain('window.__api("PUT", "/api/tenant/feedback-email"');
  });

  it("loads the stored address once at boot, not on every table render", async () => {
    const script = await clientScript();

    expect(script).toContain('window.__api("GET", "/api/tenant/feedback-email"');

    // The links table reloads on every toggle, delete and create. Re-reading a
    // tenant-level setting on each one is a request per keystroke of somebody
    // else's workflow, so it is read once, by the auth bootstrap, after the
    // gate opens (the Links island fetches only its own three endpoints:
    // web/test/links/loading.test.tsx).
    //
    // Asserted against the whole served page because the boot call lives in the
    // OTHER inline <script> — the auth bootstrap, not the dashboard client.
    const html = await serve();
    const at = html.indexOf('if (typeof loadFeedbackEmail === "function") loadFeedbackEmail();');
    expect(at).toBeGreaterThan(html.indexOf("window.__apiReadyResolve?.()"));
    // The only call: none inside a links load or any other handler.
    expect(html.split("loadFeedbackEmail();")).toHaveLength(2);
  });

  it("only claims success when the server agreed", async () => {
    const script = await clientScript();

    // A confirmation that lies is worse than no confirmation: the owner walks
    // away believing an address is recorded that is not.
    // The listener is addressed through getElementById, so the marker is that
    // call — not the `id="..."` form, which only appears in the markup.
    const fn = script.slice(script.indexOf('getElementById("feedback-email-save").addEventListener'));
    expect(fn).toContain("if (!res.ok)");
    expect(fn).toMatch(/message success[\s\S]*Saved\./);
  });

  it("surfaces the server's own message when it refuses", async () => {
    const script = await clientScript();

    // The endpoint returns `detail` — "That does not look like an email
    // address." — which beats a generic failure.
    expect(script).toContain("body.detail || body.error");
  });

  it("stays out of the delegated record switch", async () => {
    const script = await clientScript();

    // It acts on no record, and the switch's membership is pinned to seven.
    expect(script).not.toContain('case "feedback-email"');
  });
});

// ---------------------------------------------------------------------------
// The feedback inbox.
//
// The renderer itself is covered in `feedback-inbox.test.ts`. These pin the
// wiring in the served page: that the renderer actually ships, that it loads
// once at boot outside the links load's all-or-nothing fetch, and that the export
// carries the same auth as every other call instead of being a bare link.
// ---------------------------------------------------------------------------

describe("the feedback inbox", () => {
  it("ships the renderer into the page, after the esbuild shim", async () => {
    const script = await clientScript();
    const shim = script.indexOf("var __name");
    const binding = script.indexOf("const renderFeedbackInbox =");
    expect(shim).toBeGreaterThan(-1);
    expect(binding).toBeGreaterThan(shim);
  });

  it("loads the inbox once at boot, not with the links", async () => {
    const script = await clientScript();
    expect(script).toContain('window.__api("GET", "/api/review-gate/feedback" + feedbackQuery())');

    const html = await serve();
    const at = html.indexOf('if (typeof loadFeedbackInbox === "function") loadFeedbackInbox();');
    expect(at).toBeGreaterThan(html.indexOf("window.__apiReadyResolve?.()"));
  });

  it("downloads the export through window.__api, never through a bare link", async () => {
    // Auth is an Authorization header plus X-Tenant-Slug. A navigation to the
    // CSV carries neither, so an href would be a 401 the owner sees as a
    // broken button.
    const html = await serve();
    expect(html).not.toMatch(/href="\/api\/review-gate\/feedback\.csv"/);

    const script = await clientScript();
    expect(script).toContain(
      'getElementById("feedback-export").addEventListener("click", (e) =>',
    );
    const handler = extractFunction(script, "exportFeedbackCsv");
    expect(handler).toContain('window.__api("GET", "/api/review-gate/feedback.csv" + feedbackQuery())');
    expect(handler).toContain("URL.createObjectURL");
    expect(handler).toContain('res.headers.get("X-Truncated")');
  });

  it("checks res.ok before treating either response as data", async () => {
    const script = codeOnly(await clientScript());
    const exporter = extractFunction(script, "exportFeedbackCsv");
    expect(exporter.indexOf("!res.ok")).toBeGreaterThan(-1);
    expect(exporter.indexOf("!res.ok")).toBeLessThan(exporter.indexOf("res.blob()"));

    const loader = extractFunction(script, "loadFeedbackInbox");
    expect(loader.indexOf("!res.ok")).toBeGreaterThan(-1);
    expect(loader.indexOf("!res.ok")).toBeLessThan(loader.indexOf("renderFeedbackInbox("));
  });
});

// ---------------------------------------------------------------------------
// The feedback inbox, run.
//
// The served functions compiled and called against stubs. A failed request
// must say so in the card; it must never be rendered as an inbox, and never be
// saved to disk as customer-feedback.csv.
// ---------------------------------------------------------------------------

function errorResponse(status: number, body: Record<string, unknown>) {
  return {
    ok: false,
    status,
    headers: new Headers(),
    json: vi.fn().mockResolvedValue(body),
    blob: vi.fn().mockResolvedValue(new Blob([JSON.stringify(body)])),
  };
}

describe("the feedback export, when the server refuses", () => {
  async function runExport(res: unknown) {
    const script = await clientScript();
    // feedbackQuery rides along: the exporter calls it, and without it the
    // compiled function would throw before reaching the code under test.
    const src = extractFunction(script, "exportFeedbackCsv") + "\n" + extractFunction(script, "feedbackQuery");
    const URLStub = { createObjectURL: vi.fn(), revokeObjectURL: vi.fn() };
    const documentStub = {
      createElement: vi.fn(),
      body: { appendChild: vi.fn() },
      getElementById: () => ({ value: "" }),
    };
    const windowStub = { __api: vi.fn().mockResolvedValue(res) };
    const fn = new Function(
      "window",
      "document",
      "URL",
      // extractFunction starts at `function`, so the `async` it dropped is restored.
      `async ${src}\nreturn exportFeedbackCsv;`,
    )(windowStub, documentStub, URLStub) as (btn: unknown, msg: unknown) => Promise<void>;
    const btn = { disabled: false };
    const msg = { className: "", textContent: "" };
    await fn(btn, msg);
    return { btn, msg, URLStub, documentStub };
  }

  it("shows the error in the card and downloads nothing", async () => {
    const res = errorResponse(500, { error: "internal_error" });
    const { btn, msg, URLStub, documentStub } = await runExport(res);

    expect(res.blob).not.toHaveBeenCalled();
    expect(URLStub.createObjectURL).not.toHaveBeenCalled();
    expect(documentStub.createElement).not.toHaveBeenCalled();
    expect(msg.className).toBe("message error");
    expect(msg.textContent).toContain("internal_error");
    expect(btn.disabled).toBe(false);
  });

  it("still says something when the error body is not JSON", async () => {
    const res = errorResponse(401, {});
    res.json.mockRejectedValue(new SyntaxError("not json"));
    const { msg } = await runExport(res);

    expect(msg.className).toBe("message error");
    expect(msg.textContent).not.toBe("");
  });
});

describe("the feedback inbox, when the server refuses", () => {
  it("says it could not load, instead of rendering the error as an inbox", async () => {
    const script = await clientScript();
    const src = extractFunction(script, "loadFeedbackInbox") + "\n" + extractFunction(script, "feedbackQuery");
    const body = { innerHTML: "", value: "" };
    const api = vi.fn().mockResolvedValue(errorResponse(401, { error: "unauthorized" }));
    const render = vi.fn().mockReturnValue("<p>inbox</p>");
    const consoleStub = { error: vi.fn() };
    const fn = new Function(
      "window",
      "document",
      "renderFeedbackInbox",
      "console",
      `async ${src}\nreturn loadFeedbackInbox;`,
    )(
      { __api: api },
      { getElementById: () => body },
      render,
      consoleStub,
    ) as () => Promise<void>;

    await fn();

    // Proves the request was made: an error thrown before it would also land
    // on "Could not load", for the wrong reason.
    expect(api).toHaveBeenCalledWith("GET", "/api/review-gate/feedback");
    expect(render).not.toHaveBeenCalled();
    expect(body.innerHTML).toContain("Could not load comments.");
    expect(consoleStub.error).toHaveBeenCalled();
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
    expect(section(html, "businesses")).toContain('id="businesses-card"');
    expect(section(html, "comments")).toContain('id="feedback-card"');
    expect(section(html, "settings")).toContain('id="feedback-email-card"');
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
// Businesses and branches card (odd/tasks/business-branches.md, S3)
// ---------------------------------------------------------------------------

describe("businesses and branches card", () => {
  async function loadRenderer(): Promise<(b: unknown[], l: unknown[]) => string> {
    const script = await clientScript();
    const esc = await loadEsc();
    const src = extractFunction(script, "renderBusinesses");
    return new Function("esc", `${src}\nreturn renderBusinesses;`)(esc);
  }

  it("lives in the businesses section, with a field to add a business", async () => {
    const html = await serve();
    const start = html.indexOf('data-section="businesses"');
    const side = html.slice(start, html.indexOf("</section>", start));
    expect(side).toContain('id="businesses-card"');
    expect(side).toMatch(/<input[^>]*id="new-business-name"/);
    expect(side).toContain('id="add-business"');
  });

  it("groups each branch under its business, with a field to add one more", async () => {
    const render = await loadRenderer();
    const html = render(
      [{ id: "biz-1", name: "Café Central", location_count: 2 }],
      [
        { id: "loc-1", name: "Providencia", business_id: "biz-1", link_count: 3 },
        { id: "loc-2", name: "Ñuñoa", business_id: "biz-1", link_count: 0 },
      ],
    );
    const group = html.slice(html.indexOf("Café Central"));
    expect(group.indexOf("Providencia")).toBeGreaterThan(-1);
    expect(group.indexOf("Ñuñoa")).toBeGreaterThan(-1);
    expect(html).toMatch(/<input[^>]*id="new-branch-biz-1"/);
    expect(html).toMatch(/data-biz-action="add-branch"[^>]*data-business-id="biz-1"/);
  });

  it("lists branches without a business separately, so they can be moved into one", async () => {
    const render = await loadRenderer();
    const html = render(
      [{ id: "biz-1", name: "Café Central", location_count: 0 }],
      [{ id: "loc-9", name: "Cards", business_id: null, link_count: 59 }],
    );
    expect(html).toContain("Not in a business");
    expect(html).toMatch(/<select[^>]*id="move-loc-9"/);
    expect(html).toMatch(/<option value="biz-1">Café Central<\/option>/);
    expect(html).toMatch(/data-biz-action="move-branch"[^>]*data-location-id="loc-9"/);
  });

  it("escapes business and branch names", async () => {
    const render = await loadRenderer();
    const html = render(
      [{ id: "biz-1", name: XSS_URL, location_count: 1 }],
      [{ id: "loc-1", name: XSS_URL, business_id: "biz-1", link_count: 0 }],
    );
    expect(html).not.toContain("<img");
  });

  it("creates businesses and branches through the API, then refreshes everything that names them", async () => {
    const script = await clientScript();
    expect(extractFunction(script, "addBusiness")).toContain('window.__api("POST", "/api/businesses"');
    const addBranch = extractFunction(script, "addBranch");
    expect(addBranch).toContain('window.__api("POST", "/api/locations"');
    expect(addBranch).toContain("business_id: businessId");
    const move = extractFunction(script, "moveBranch");
    expect(move).toContain('window.__api("PATCH", "/api/locations/" + locationId');
    expect(move).toContain('business_id: value === "none" ? null : value');
    // A moved branch changes the business shown on every link row.
    expect(extractFunction(script, "refreshOwnership")).toContain("if (window.__loadLinks) window.__loadLinks();");
  });

  it("loads businesses with the branches", async () => {
    expect(extractFunction(await clientScript(), "loadBranches")).toContain('"/api/businesses"');
  });
});

// ---------------------------------------------------------------------------
// Filtering comments by business or branch (odd/tasks/business-branches.md, S5)
// ---------------------------------------------------------------------------

describe("comments can be filtered by business or branch", () => {
  it("offers a filter above the comments", async () => {
    const html = await serve();
    const card = html.slice(html.indexOf('id="feedback-card"'));
    expect(card).toMatch(/<select[^>]*id="feedback-filter"/);
  });

  it("turns the filter into the API's query string, for the list and the CSV alike", async () => {
    const script = await clientScript();
    const fn = extractFunction(script, "feedbackQuery");
    const run = new Function("document", `${fn}\nreturn feedbackQuery();`);
    const doc = (value: string) => ({ getElementById: () => ({ value }) });
    expect(run(doc(""))).toBe("");
    expect(run(doc("b:biz-1"))).toBe("?business_id=biz-1");
    expect(run(doc("l:loc-1"))).toBe("?location_id=loc-1");
    expect(extractFunction(script, "loadFeedbackInbox")).toContain('"/api/review-gate/feedback" + feedbackQuery()');
    expect(extractFunction(script, "exportFeedbackCsv")).toContain('"/api/review-gate/feedback.csv" + feedbackQuery()');
  });

  it("reloads the comments when the chosen filter no longer exists", async () => {
    const script = await clientScript();
    const fn = extractFunction(script, "fillFeedbackFilter") + "\n" + extractFunction(script, "pickableBranches");
    const reload = vi.fn();
    // Before the rebuild the chosen option is still in the list, as in a real
    // <select>; the rebuild is what drops it.
    const options: string[] = ["", "b:gone"];
    const select = {
      _value: "b:gone",
      get value() { return options.includes(this._value) ? this._value : ""; },
      set value(v: string) { this._value = v; },
      set textContent(_v: string) { options.length = 0; },
      add: (o: { value: string }) => options.push(o.value),
    };
    new Function("window", "document", "Option", "loadFeedbackInbox", `${fn}\nfillFeedbackFilter();`)(
      { __businesses: [], __branches: [] },
      { getElementById: () => select },
      function (_l: string, value: string) { return { value }; },
      reload,
    );
    expect(select.value).toBe("");
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("fills the filter from the businesses and branches it loaded", async () => {
    expect(extractFunction(await clientScript(), "loadBranches")).toContain("fillFeedbackFilter()");
  });
});

// ---------------------------------------------------------------------------
// Moving grouped branches, and switching businesses and branches off
//
// Requested after PR #83: "Poder pasar a otro local una sucursal que ya tiene
// uno" and "Ocultar los locales y sucursales desactivados en los selectores".
// ---------------------------------------------------------------------------

describe("grouped branches can move, and inactive ones leave the pickers", () => {
  async function loadRenderer(): Promise<(b: unknown[], l: unknown[]) => string> {
    const script = await clientScript();
    const esc = await loadEsc();
    const src = extractFunction(script, "renderBusinesses") + "\n" + extractFunction(script, "pickableBranches");
    return new Function("esc", `${src}\nreturn renderBusinesses;`)(esc);
  }
  const businesses = [
    { id: "biz-1", name: "Café Central", is_active: true },
    { id: "biz-2", name: "Sabores", is_active: true },
    { id: "biz-3", name: "Cerrado", is_active: false },
  ];

  it("lets a branch that has a business move to another one, or to none", async () => {
    const html = (await loadRenderer())(businesses, [
      { id: "loc-1", name: "Providencia", business_id: "biz-1", is_active: true, link_count: 3 },
    ]);
    const select = html.match(/<select[^>]*id="move-loc-1"[^>]*>([\s\S]*?)<\/select>/)?.[1] ?? "";
    expect(select).toContain('<option value="biz-2">Sabores</option>');
    expect(select).toContain('<option value="none">No business</option>');
    // Not its own business, and never an inactive one.
    expect(select).not.toContain('value="biz-1"');
    expect(select).not.toContain('value="biz-3"');
    expect(html).toMatch(/data-biz-action="move-branch"[^>]*data-location-id="loc-1"/);
  });

  it("offers Deactivate on active businesses and branches, Activate on inactive ones", async () => {
    const html = (await loadRenderer())(businesses, [
      { id: "loc-1", name: "Providencia", business_id: "biz-1", is_active: true, link_count: 0 },
      { id: "loc-2", name: "Vieja", business_id: "biz-1", is_active: false, link_count: 0 },
    ]);
    expect(html).toMatch(/<button[^>]*data-biz-action="toggle-business"[^>]*data-business-id="biz-1"[^>]*data-active="false"[^>]*>Deactivate<\/button>/);
    expect(html).toMatch(/<button[^>]*data-biz-action="toggle-business"[^>]*data-business-id="biz-3"[^>]*data-active="true"[^>]*>Activate<\/button>/);
    expect(html).toMatch(/<button[^>]*data-biz-action="toggle-branch"[^>]*data-location-id="loc-1"[^>]*data-active="false"[^>]*>Deactivate<\/button>/);
    expect(html).toMatch(/<button[^>]*data-biz-action="toggle-branch"[^>]*data-location-id="loc-2"[^>]*data-active="true"[^>]*>Activate<\/button>/);
  });

  it("keeps inactive businesses and branches out of the comments filter", async () => {
    const script = await clientScript();
    const fn = extractFunction(script, "fillFeedbackFilter") + "\n" + extractFunction(script, "pickableBranches");
    const options: string[] = [""];
    const select = {
      value: "",
      set textContent(_v: string) { options.length = 0; },
      add: (o: { value: string }) => options.push(o.value),
    };
    new Function("window", "document", "Option", "loadFeedbackInbox", `${fn}\nfillFeedbackFilter();`)(
      {
        __businesses: businesses,
        __branches: [
          { id: "loc-1", name: "Providencia", business_id: "biz-1", is_active: true },
          { id: "loc-2", name: "Vieja", business_id: "biz-1", is_active: false },
          { id: "loc-3", name: "Centro", business_id: "biz-3", is_active: true },
          { id: "loc-4", name: "Suelta", business_id: null, is_active: false },
        ],
      },
      { getElementById: () => select },
      function (_l: string, value: string) { return { value }; },
      () => {},
    );
    expect(options).toEqual(["", "b:biz-1", "l:loc-1", "b:biz-2"]);
  });

  it("moves to no business with null, and switches businesses and branches through PATCH", async () => {
    const script = await clientScript();
    const api = vi.fn().mockResolvedValue({ ok: true });
    const refresh = vi.fn();
    const deps = ["window", "document", "showBusinessesMessage", "refreshOwnership"];
    const win = { __api: api };
    const doc = { getElementById: () => ({ value: "none" }) };

    await new Function(...deps, `async ${extractFunction(script, "moveBranch")}\nreturn moveBranch("loc-1");`)(win, doc, () => {}, refresh);
    expect(api).toHaveBeenLastCalledWith("PATCH", "/api/locations/loc-1", { business_id: null });

    await new Function(...deps, `async ${extractFunction(script, "setBusinessActive")}\nreturn setBusinessActive("biz-1", false);`)(win, doc, () => {}, refresh);
    expect(api).toHaveBeenLastCalledWith("PATCH", "/api/businesses/biz-1", { is_active: false });

    await new Function(...deps, `async ${extractFunction(script, "setBranchActive")}\nreturn setBranchActive("loc-1", true);`)(win, doc, () => {}, refresh);
    expect(api).toHaveBeenLastCalledWith("PATCH", "/api/locations/loc-1", { is_active: true });
    expect(refresh).toHaveBeenCalledTimes(3);
  });

  it("routes the new card actions through the delegated listener", async () => {
    const script = await clientScript();
    const listener = script.slice(script.indexOf('getElementById("businesses-body").addEventListener'));
    expect(listener).toContain('"toggle-business"');
    expect(listener).toContain('setBusinessActive(el.dataset.businessId, el.dataset.active === "true")');
    expect(listener).toContain('setBranchActive(el.dataset.locationId, el.dataset.active === "true")');
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

  it("keeps everything the remaining legacy code calls", async () => {
    const script = codeOnly(await clientScript());

    // refreshOwnership still reloads the table through the island's bridge,
    // and the bootstrap still finds the boot loaders it calls by name.
    expect(extractFunction(script, "refreshOwnership")).toContain("if (window.__loadLinks) window.__loadLinks();");
    for (const fn of ["loadBranches", "loadFeedbackEmail", "loadFeedbackInbox", "showSection", "esc"]) {
      expect(script, fn).toMatch(new RegExp(`function ${fn}\\(`));
    }
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
