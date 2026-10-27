import { describe, it, expect, vi } from "vitest";
import { dashboardHandler } from "../../src/handlers/dashboard";

// ---------------------------------------------------------------------------
// Stored-XSS regression tests for the dashboard.
//
// The links table is built client-side: the handler serves an HTML shell whose
// inline <script> assigns a template string to `tbody.innerHTML`. The server
// never renders a row itself, so these tests extract the real row template out
// of the SERVED output and execute it. Asserting against a hand-copied copy of
// the template would pass while the shipped code stayed vulnerable, which is
// exactly the regression this file exists to prevent.
// ---------------------------------------------------------------------------

const XSS_URL = '<img src=x onerror=alert(1)>';
// Escapes a JS string literal inside an inline onclick="..." handler.
const XSS_CODE = "');alert(1)//";
const XSS_ATTR = '"><img src=x onerror=alert(1)>';
const ESCAPED_ATTR = "&quot;&gt;&lt;img src=x onerror=alert(1)&gt;";

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
 * Returns the inline <script> block that owns the links table. The shell's
 * other inline block is the Supabase auth bootstrap and is not a `<script>` with
 * no attributes, so `<script>` matches only the dashboard body.
 */
async function clientScript(): Promise<string> {
  const html = await serve();
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  if (!script || !script.includes("links-body")) {
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
 * Compiles the arrow function that `loadLinks` hands to `links.map(...)` and
 * returns a row renderer bound to the served `esc()`.
 */
async function loadRowRenderer(): Promise<(l: Record<string, unknown>) => string> {
  const script = await clientScript();
  const anchor = "links.map((l) => {";
  const start = script.indexOf(anchor);
  if (start < 0) throw new Error("links.map row template not found");
  const from = start + "links.map(".length;
  const to = script.indexOf('}).join("")', from);
  if (to < 0) throw new Error("end of links.map row template not found");
  const arrow = script.slice(from, to + 1);
  const esc = await loadEsc();
  return new Function("esc", `return (${arrow});`)(esc) as (
    l: Record<string, unknown>,
  ) => string;
}

/** Renders one links-table row through the shipped template. */
async function renderRow(over: Record<string, unknown> = {}): Promise<string> {
  const link = {
    id: "link-uuid",
    short_code: "abc1234",
    short_url: "https://short.link/abc1234",
    original_url: "https://example.com",
    title: null,
    client_ref: null,
    clicks_count: 5,
    is_active: true,
    expires_at: null,
    ...over,
  };
  return (await loadRowRenderer())(link);
}

/**
 * Compiles the `([k, v]) => ...` mapper used by the metric breakdown
 * renderers. All three renderers (country/device/source) share its shape; the
 * tests assert on the shared source plus the number of call sites.
 */
async function loadMetricMapper(): Promise<(entry: [string, number]) => string> {
  const script = await clientScript();
  const match = script.match(/\.map\(\(\[k, v\]\) => (`[\s\S]*?`)\)/);
  if (!match) throw new Error("metric breakdown mapper not found");
  const esc = await loadEsc();
  return new Function("esc", `return (([k, v]) => ${match[1]});`)(esc) as (
    entry: [string, number],
  ) => string;
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

describe("dashboardHandler shell", () => {
  it("serves HTML with a text/html content type", async () => {
    const response = await dashboardHandler(mockContext());

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/html");
  });

  it("serves the dashboard markup and the empty table body", async () => {
    const html = await serve();

    expect(html).toContain('<tbody id="links-body"></tbody>');
    expect(html).toContain("Your Links");
  });
});

// ---------------------------------------------------------------------------
// Class A — HTML context: escaping
// ---------------------------------------------------------------------------

describe("links table — HTML-context escaping", () => {
  it("never emits a raw <img when original_url carries markup", async () => {
    const row = await renderRow({ original_url: XSS_URL });

    // The `<` is neutralised, so no element is ever created. The literal text
    // "onerror=" legitimately survives as escaped text content — asserting its
    // absence would be asserting an escaping artifact, not the invariant.
    expect(row).not.toContain("<img");
    expect(row).toContain("&lt;img");
  });

  it("escapes the URL in the title attribute as well as the text node", async () => {
    // XSS_ATTR opens with a quote: unescaped it would close the title
    // attribute early and let the attacker add attributes of their own.
    const row = await renderRow({ original_url: XSS_ATTR });

    expect(row).not.toContain('"><img');
    // Every render position escaped: the title attribute, the text node, and
    // the panel's editable destination field.
    expect(row.split(`title="${ESCAPED_ATTR}"`).length - 1).toBe(1);
    expect(row.split(`value="${ESCAPED_ATTR}"`).length - 1).toBe(1);
    expect(row.split(ESCAPED_ATTR).length - 1).toBe(3);
  });

  it("escapes client_ref in the input value", async () => {
    const row = await renderRow({ client_ref: XSS_ATTR });

    expect(row).not.toContain('<img src=x');
    expect(row).toContain("&quot;&gt;&lt;img");
  });

  it("renders null and undefined fields as empty rather than 'null'", async () => {
    const esc = await loadEsc();

    expect(esc(null)).toBe("");
    expect(esc(undefined)).toBe("");
    const row = await renderRow({ client_ref: null, original_url: "https://example.com" });
    expect(row).not.toContain("null");
  });
});

// ---------------------------------------------------------------------------
// Class B — JavaScript context: no inline handlers at all
// ---------------------------------------------------------------------------

describe("links table — no inline event handlers", () => {
  it("the row template source contains no onclick attribute", async () => {
    const script = await clientScript();
    const anchor = "links.map((l) => {";
    const start = script.indexOf(anchor);
    const to = script.indexOf('}).join("")', start);
    const template = script.slice(start, to);

    expect(template).not.toContain("onclick");
    expect(template).not.toMatch(/\bon[a-z]+\s*=/);
  });

  it("renders rows with no inline handler attribute at all", async () => {
    const row = await renderRow();

    expect(row).not.toContain("onclick");
    expect(row).not.toMatch(/\son[a-z]+\s*=\s*["']/);
  });

  it("delivers short_code only via data-* attributes, never into a handler", async () => {
    const row = await renderRow({ short_code: XSS_CODE });

    expect(row).not.toContain("onclick");
    // Escaped in the attribute, so the payload cannot reopen a JS string.
    expect(row).not.toContain(XSS_CODE);
    expect(row).toContain("data-code=");
  });

  it("marks every interactive control with a data-action for delegation", async () => {
    const row = await renderRow();

    const actions = [...row.matchAll(/data-action="([^"]+)"/g)].map((m) => m[1]);
    expect(actions.sort()).toEqual(
      ["copy", "delete", "edit", "metrics", "qr", "save-branch", "save-client-ref", "save-destination", "toggle", "toggle-gate"].sort(),
    );
  });

  it("binds one delegated click listener on the stable #links-body ancestor", async () => {
    const script = await clientScript();

    expect(script).toMatch(/getElementById\("links-body"\)\s*\n?\s*\.addEventListener\("click"/);
    expect(script).toContain('closest("[data-action]")');
    // Every action is dispatched from the dataset, never from a string literal.
    for (const action of ["copy", "qr", "metrics", "edit", "save-client-ref", "save-destination", "save-branch", "toggle", "toggle-gate", "delete"]) {
      expect(script).toMatch(new RegExp(`case "${action}":`));
    }
  });

  it("keeps the existing client-side function signatures intact", async () => {
    const script = await clientScript();

    expect(script).toMatch(/function copyUrl\(url, el\)/);
    expect(script).toMatch(/function showQR\(url, e\)/);
    expect(script).toMatch(/async function toggleLink\(id, active\)/);
    expect(script).toMatch(/async function saveClientRef\(id\)/);
    expect(script).toMatch(/async function showMetrics\(linkId, code, e\)/);
    expect(script).toMatch(/async function deleteLink\(id\)/);
  });

  it("preserves the copy-to-clipboard visual feedback via dataset.code", async () => {
    const script = await clientScript();

    expect(script).toContain("el.textContent = \"Copied!\"");
    expect(script).toContain("el.textContent = el.dataset.code");
  });
});

// ---------------------------------------------------------------------------
// Metric breakdown renderers
// ---------------------------------------------------------------------------

describe("metric breakdown renderers", () => {
  it("escapes the breakdown key before it reaches innerHTML", async () => {
    const row = (await loadMetricMapper())([XSS_URL, 3]);

    expect(row).not.toContain("<img");
    expect(row).toContain("&lt;img");
  });

  it("escapes the breakdown value as well as the key", async () => {
    const mapper = await loadMetricMapper();
    const row = mapper(["US", XSS_URL]);

    expect(row).not.toContain("<img");
    expect(row).toContain("&lt;img");
  });

  it("routes all three breakdown panels through the escaping mapper", async () => {
    const script = await clientScript();

    // by_country, by_device, by_source — three call sites, one mapper shape.
    expect(script.match(/\.map\(\(\[k, v\]\) => `[\s\S]*?`\)/g)).toHaveLength(3);
    for (const field of ["by_country", "by_device", "by_source"]) {
      // by_source is read defensively as `data.by_source || {}`
      expect(script).toContain(`Object.entries(data.${field}`);
    }
  });

  it("escapes err.message before it is concatenated into innerHTML", async () => {
    const script = await clientScript();
    const render = script.match(
      /countryDiv\.innerHTML = "<div class='metric-row'>Error: "[\s\S]*?<\/div>";/,
    )?.[0];

    expect(render).toBeDefined();
    expect(render).toContain("esc(");
  });
});

// ---------------------------------------------------------------------------
// The esc() helper itself
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

  it("repeats the caveat inside each link's metrics panel, next to the numbers", async () => {
    // The static note is above the table; the numbers are inside the expander.
    // Someone who expands a row without scrolling up must still meet the caveat.
    const row = await renderRow();

    expect(row).toContain(VISITOR_ESTIMATE_CAVEAT);
    // It sits in the same panel as the two figures, not somewhere off in a footer.
    const panel = row.slice(row.indexOf("Visitors (estimate)"));
    expect(panel).toContain("visitors-");
    expect(panel).toContain(VISITOR_ESTIMATE_CAVEAT);
  });

  it("labels the panel as an estimate in its own heading", async () => {
    const row = await renderRow();

    // The heading is what is visible at a glance; the caveat is the detail.
    expect(row).toContain("Visitors (estimate)");
  });

  it("shows the store-level rollup behind the same caveat", async () => {
    const region = await staticRegion();

    expect(region).toContain('id="clients-card"');
    expect(region).toContain('id="clients-body"');
    // Bounded by the static region, so this cannot be satisfied by the copy
    // that lives inside the inline script.
    const card = region.slice(region.indexOf('id="clients-card"'));
    expect(card).toContain(VISITOR_ESTIMATE_CAVEAT);
  });
});

describe("renderVisitors", () => {
  type Render = (data: Record<string, unknown>) => string;

  it("renders both figures when the API supplies them", async () => {
    const render = await loadClientFunction<Render>("renderVisitors");

    const html = render({
      unique_visitors: 30,
      sessions: 42,
      unique_window: "1 day",
      session_window: "30 minutes",
    });

    expect(html).toContain("30");
    expect(html).toContain("42");
  });

  it("gives the two figures identical markup — no hierarchy between them", async () => {
    const render = await loadClientFunction<Render>("renderVisitors");

    const html = render({
      unique_visitors: 30,
      sessions: 42,
      unique_window: "1 day",
      session_window: "30 minutes",
    });

    const rows = [...html.matchAll(/<div class="metric-row">[\s\S]*?<\/div>/g)].map((m) => m[0]);
    expect(rows).toHaveLength(2);

    // Same container, same label element, same value element, same ordering of
    // label-then-value. If one figure were ever rendered as <h4> and the other
    // as <strong>, or given its own class, this fails.
    for (const row of rows) {
      expect(row).toContain('<span>');
      expect(row).toContain("<strong>");
      expect(row).toContain('class="metric-row"');
    }
    // Neither is marked up as primary, secondary, or a footnote.
    expect(html).not.toMatch(/class="[^"]*(primary|secondary|highlight|subtle)/i);
  });

  it("labels each figure with the window the API actually used", async () => {
    const render = await loadClientFunction<Render>("renderVisitors");

    const html = render({
      unique_visitors: 30,
      sessions: 42,
      unique_window: "7 days",
      session_window: "15 minutes",
    });

    // Read from the response, not hardcoded here — otherwise the label can
    // describe a window the SQL no longer uses.
    expect(html).toContain("7 days");
    expect(html).toContain("15 minutes");
  });

  it("reports zero rather than undefined when a figure is absent", async () => {
    const render = await loadClientFunction<Render>("renderVisitors");

    const html = render({});

    // "undefined" next to a real number reads as a measurement.
    expect(html).not.toContain("undefined");
    expect(html.match(/<strong>0<\/strong>/g)).toHaveLength(2);
  });

  it("escapes the window labels it interpolates", async () => {
    const render = await loadClientFunction<Render>("renderVisitors");

    const html = render({
      unique_visitors: 1,
      sessions: 1,
      unique_window: XSS_URL,
      session_window: XSS_URL,
    });

    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });
});

describe("renderClients", () => {
  type Render = (clients: unknown) => string;

  it("renders one row per client with both figures", async () => {
    const render = await loadClientFunction<Render>("renderClients");

    const html = render([
      { client_ref: "ACME-0042", unique_visitors: 30, sessions: 42 },
    ]);

    expect(html).toContain("ACME-0042");
    expect(html).toContain("30");
    expect(html).toContain("42");
    expect([...html.matchAll(/<tr>/g)]).toHaveLength(1);
  });

  it("escapes client_ref, which is user-supplied free text", async () => {
    const render = await loadClientFunction<Render>("renderClients");

    const html = render([
      { client_ref: XSS_ATTR, unique_visitors: 1, sessions: 1 },
    ]);

    expect(html).not.toContain('"><img');
    expect(html).toContain("&quot;&gt;&lt;img");
  });

  it("explains the empty state instead of rendering a bare table", async () => {
    const render = await loadClientFunction<Render>("renderClients");

    const html = render([]);

    expect(html).toContain("No client identifiers");
  });
});

describe("Phase 2 markup did not regress the escaping and delegation guards", () => {
  it("keeps the metrics row free of inline event handlers", async () => {
    // The visitors box was added inside the row template — the exact place
    // Phase 1.5 removed the injected-JS vulnerability from.
    const row = await renderRow();

    expect(row).not.toContain("onclick");
    expect(row).not.toMatch(/\son[a-z]+\s*=\s*["']/);
  });

  it("adds no new delegated actions to the links table", async () => {
    const row = await renderRow();

    const actions = [...row.matchAll(/data-action="([^"]+)"/g)].map((m) => m[1]);
    expect(actions.sort()).toEqual(
      ["copy", "delete", "edit", "metrics", "qr", "save-branch", "save-client-ref", "save-destination", "toggle", "toggle-gate"].sort(),
    );
  });

  it("keeps exactly three breakdown panels on the shared mapper", async () => {
    const script = await clientScript();

    // The visitor pair has its own renderer precisely so it does not inflate
    // this count.
    expect(script.match(/\.map\(\(\[k, v\]\) => `[\s\S]*?`\)/g)).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// The loadLinks / auth-bootstrap ordering
//
// The dashboard serves TWO inline scripts and they do not run in a
// cooperative order:
//
//   <script>  (container)   defines loadLinks, wires the create form
//   <script src=...supabase>
//   <script>  (shell)       async IIFE -> await sb.auth.getSession()
//                           -> defines window.__api -> loadLinks()
//
// The shell bootstrap suspends on a network round-trip, so anything the
// container script does at parse time runs while window.__api does not yet
// exist. A parse-time `loadLinks()` there therefore reached
// `window.__api("GET", ...)` and threw a TypeError that loadLinks' own catch
// turned into "Could not load links. window.__api is not a function".
//
// There is no DOM in the workers pool, so these tests do not simulate clicks or
// run a live page. They work on the SERVED script two ways: the ordering
// behaviour is exercised by executing the shipped `loadLinks` against a stub
// `window`/`document` — which is where the real defect lived, inside the
// function rather than in a click handler — and the parse-time wiring is
// asserted on the served source, because that part genuinely is about the
// order of statements in the document.
// ---------------------------------------------------------------------------

type ElementStub = {
  style: { display: string };
  textContent: string;
  innerHTML: string;
  dataset: Record<string, unknown>;
  addEventListener: (type: string, handler: unknown) => void;
};

type Request = { method: string; path: string };

interface Harness {
  /** The shipped loadLinks, bound to the stubs below. */
  loadLinks: () => Promise<void>;
  /** Exactly what the shell bootstrap calls once window.__api exists. */
  resolveGate: () => void;
  requests: Request[];
  el: (id: string) => ElementStub;
  win: Record<string, any>;
}

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
 * The elements this page serves already hidden, per its own inline styles:
 * #links-table, #links-empty and #clients-card all carry display:none and are
 * revealed by loadLinks once it has something to show. Without seeding that, a
 * stub that starts blank could not tell "loadLinks revealed nothing" apart from
 * "loadLinks revealed the empty state" — which is the whole assertion.
 */
const SERVED_HIDDEN_IDS = ["links-table", "links-empty", "clients-card"];

/**
 * Compiles the served `loadLinks()` against a stub DOM and an EMPTY window.
 *
 * The stub document returns a fresh element per id, so loadLinks runs its real
 * body — real assignments, real try/catch — without a browser. `window.__api`
 * is deliberately left undefined: that is exactly the state the container
 * script sees while the shell bootstrap is still awaiting getSession().
 */
async function mountDashboard(): Promise<Harness> {
  const script = await clientScript();
  const esc = await loadEsc();
  const renderClients = await loadClientFunction<(c: unknown) => string>("renderClients");

  // The gate statement is served source, not a stand-in. It is applied only if
  // the page actually creates one: on the pre-fix page there is no gate, and
  // the harness must still be able to run loadLinks so the test fails on its
  // own assertion — the rendered production error — instead of on a missing
  // fixture. That keeps the RED evidence about the defect rather than the rig.
  const gateSrc = script.match(/\n\s*(window\.__apiReady = new Promise\(.*\);)\n/)?.[1];

  const elements: Record<string, ElementStub> = {};
  const el = (id: string): ElementStub => {
    if (!elements[id]) {
      elements[id] = stubElement();
      if (SERVED_HIDDEN_IDS.includes(id)) elements[id].style.display = "none";
    }
    return elements[id];
  };
  const win: Record<string, any> = {};
  const requests: Request[] = [];

  if (gateSrc) new Function("window", gateSrc)(win);

  // extractFunction() matches on `function loadLinks(`, which drops the `async`
  // keyword, so the prefix is restored here — the shipped function is async and
  // its body awaits.
  const loadLinks = new Function(
    "window",
    "document",
    "esc",
    "renderClients",
    `return async ${extractFunction(script, "loadLinks")}`,
  )(win, { getElementById: el }, esc, renderClients) as () => Promise<void>;

  return {
    loadLinks,
    // Optional call: a page without a gate must not hang this harness.
    resolveGate: () => win.__apiReadyResolve?.(),
    requests,
    el,
    win,
  };
}

/** A window.__api that records its calls and answers with empty collections. */
function recordingApi(requests: Request[]) {
  return async (method: string, path: string) => {
    requests.push({ method, path });
    return { ok: true, json: async () => [] };
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

describe("loadLinks ordering against the auth bootstrap", () => {
  it("does not throw or request anything when invoked before the session resolves", async () => {
    const dash = await mountDashboard();

    // Parse-time ordering: loadLinks runs, window.__api does not exist yet.
    const pending = dash.loadLinks();

    // The defect surfaced as a rendered error, because loadLinks swallows the
    // TypeError into the empty state. That message is the production symptom.
    expect(dash.requests).toHaveLength(0);
    expect(dash.el("links-empty").textContent).toBe("");
    expect(dash.el("links-empty").style.display).toBe("none");

    // And it is still waiting rather than having silently failed.
    dash.win.__api = recordingApi(dash.requests);
    dash.resolveGate();
    await pending;

    // The load it deferred actually happens, once the API is available.
    //
    // Asserted by SHAPE rather than by endpoint list, because the property
    // under test is the ordering and not the number of requests: the same
    // invariant has to hold for the one-request form of loadLinks that predates
    // the client_ref rollup getting its own URL. The shipped endpoint set is
    // pinned separately below.
    expect(dash.requests.length).toBeGreaterThan(0);
    for (const request of dash.requests) {
      expect(request.method).toBe("GET");
      expect(request.path).toMatch(/^\/api\//);
    }
    // The load ran to completion rather than parking half-rendered.
    expect(dash.el("link-count").textContent).toBe(0);
    expect(dash.el("links-loading").style.display).toBe("none");
  });

  it("uses whatever window.__api is bound at resolve time, not one captured early", async () => {
    const dash = await mountDashboard();

    const pending = dash.loadLinks();
    // Bound AFTER loadLinks was invoked and while it was suspended.
    dash.win.__api = recordingApi(dash.requests);
    dash.resolveGate();
    await pending;

    // Nothing is requested until the late-bound helper is actually called, so
    // a request here can only have come through the binding made after the
    // invocation. Zero would mean the deferred load never ran.
    expect(dash.requests.length).toBeGreaterThan(0);
    expect(dash.el("links-empty").textContent).toBe("");
  });

  it("loads normally for a caller that runs after the gate is already open", async () => {
    const dash = await mountDashboard();
    dash.win.__api = recordingApi(dash.requests);
    dash.resolveGate();
    await Promise.resolve();

    await dash.loadLinks();

    // The gate adds a microtask to an already-open path; it does not swallow
    // the load. This is the case the four in-handler refreshes depend on.
    expect(dash.requests.length).toBeGreaterThan(0);
    expect(dash.el("links-loading").style.display).toBe("none");
  });

  it("issues the shipped endpoint set once the gate opens", async () => {
    // The contract itself: the links collection, the client_ref rollup, and
    // the review-gate panel, fetched together. Pinned here rather than inside
    // the ordering tests so those stay independent of how many endpoints
    // loadLinks asks for.
    const dash = await mountDashboard();
    dash.win.__api = recordingApi(dash.requests);

    const pending = dash.loadLinks();
    dash.resolveGate();
    await pending;

    expect(dash.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /api/links",
      "GET /api/clients/metrics",
      "GET /api/review-gate/metrics",
    ]);
  });

  it("waits on the gate before the first request, whatever the endpoint count", async () => {
    const src = extractFunction(await clientScript(), "loadLinks");

    const gateAt = src.indexOf("__apiReady");
    const firstRequestAt = src.indexOf("window.__api(");

    expect(gateAt).toBeGreaterThan(-1);
    expect(firstRequestAt).toBeGreaterThan(-1);
    // The gate is awaited once, ahead of every request in the function. That
    // ordering — not a particular number of endpoints — is what makes the fix
    // hold for BOTH the one-request form of loadLinks (links only, pre-Phase 2)
    // and the two-request form shipped today.
    expect(gateAt).toBeLessThan(firstRequestAt);
    // Guarded, so loadLinks stays safe if it is ever invoked in a context where
    // the container script did not create the gate.
    expect(src).toMatch(/if \(window\.__apiReady\) await window\.__apiReady;/);
  });
});

describe("the dashboard script never triggers a load at parse time", () => {
  it("never calls loadLinks from the script's top-level wiring", async () => {
    const script = await clientScript();

    // Matched as whole STATEMENTS at line start, so the prose beside the gate
    // is free to name loadLinks() while explaining why it no longer calls it.
    //
    // Indentation carries the information here: this served script indents its
    // top-level statements by exactly six spaces, and every call that lives
    // inside a function or an event handler sits deeper. A bare loadLinks()
    // statement at the parse-time indentation is exactly the regression — it
    // ran before the session resolved and before window.__api existed.
    const TOP_LEVEL_INDENT = 6;
    const statements = [...script.matchAll(/^([ \t]*)loadLinks\(\);[ \t]*$/gm)].map(
      (m) => m[1].length,
    );

    // One call per handler that changes the table: create form submit, bulk
    // create, destination save, branch save, toggle, review-screen toggle,
    // client-ref save, delete, and refreshOwnership (a business or branch
    // changed). A parse-time call anywhere pushes this to ten.
    expect(statements).toHaveLength(9);
    expect(statements.every((indent) => indent > TOP_LEVEL_INDENT)).toBe(true);
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

  it("keeps its guarded loadLinks call after the resolve", async () => {
    const html = await serve();
    const auth = html.slice(html.indexOf("<script src="));

    // Matched as the whole statement, so the explanatory comment above it
    // cannot satisfy — or break — the ordering assertion.
    const call = 'if (typeof loadLinks === "function") loadLinks();';
    const callAt = auth.indexOf(call);
    const resolveAt = auth.indexOf("window.__apiReadyResolve?.()");
    const helperAt = auth.indexOf("window.__api = async");

    expect(callAt).toBeGreaterThan(-1);
    expect(resolveAt).toBeGreaterThan(-1);
    // The gate opens after the helper exists, not merely after the session.
    expect(helperAt).toBeLessThan(resolveAt);
    // And before the bootstrap's own load, so nothing is left waiting.
    expect(resolveAt).toBeLessThan(callAt);
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

  // __api calls the picker synchronously on a 409, and loadLinks runs at the end
  // of the same IIFE. Defined later, it is undefined at the moment of call.
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
// `dashboard.ts` ships `renderGatePanel` to the browser by inlining its source
// with `Function.prototype.toString()`. That source is NOT the source in this
// repository: the Worker is compiled by esbuild with `keepNames: true` before
// `.toString()` ever runs, and esbuild rewrites every named function inside a
// body into a `__name(fn, "fn")` statement. Those statements travel inside the
// stringified function and then execute in the page.
//
// `__name` is defined at the top of the Worker bundle — module scope — so it
// never reaches the page, and the first call throws
// `ReferenceError: __name is not defined`. The gate panel silently fails to
// render.
//
// The rehydration test in `gate-panel.test.ts` cannot catch this: Vitest runs
// the module unbundled, so `.toString()` there returns clean source and every
// helper looks self-contained. These tests reproduce the shipped, bundled
// shape instead.
// ---------------------------------------------------------------------------

describe("the dashboard declares the esbuild runtime its injected panel calls", () => {
  /** Everything the page declares before the panel binding — its whole scope. */
  async function panelPreamble(): Promise<string> {
    const script = await clientScript();
    const anchor = script.indexOf("const renderGatePanel =");
    if (anchor < 0) throw new Error("renderGatePanel binding not found");
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

  it("declares __name before the panel that calls it", async () => {
    expect(await panelPreambleCode()).toMatch(/\bvar __name\b/);
  });

  it("runs a panel body carrying keepNames output", async () => {
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
      const renderGatePanel = function (payload) {
        function escapeHtml(raw) { return raw; }
        __name(escapeHtml, "escapeHtml");
        return typeof escapeHtml;
      };
      return renderGatePanel;
    `);

    const panel = build() as (p: unknown) => string;
    expect(panel({})).toBe("function");
  });

  it("declares the helper as a var, so the body resolves it as a global", async () => {
    // A `const` at the top of a classic script does NOT become a global
    // property, and the panel body is a different function. `var` is what makes
    // the lookup work; this pins that choice so it is not "cleaned up" later.
    const code = await panelPreambleCode();
    expect(code).toMatch(/\bvar __name\b/);
    expect(code).not.toMatch(/\bconst __name\b/);
  });
});

// ---------------------------------------------------------------------------
// The QR encoding guard.
//
// The QR image is fetched from a third-party service with the URL as a query
// parameter, so the URL gets percent-encoded for transport. The service decodes
// that parameter once and encodes whatever it finds inside the QR image.
//
// That makes the round trip exact only if the payload is encoded ONCE. The
// handler encoded twice — once at the click handler and again inside showQR —
// so the image encoded `https%3A%2F%2F...` and scanning a sticker led nowhere.
// The bug was invisible in the UI: the caption under the image decoded its way
// back to a correct-looking URL, so the only place the wrong bytes appeared was
// the one place that mattered.
//
// These tests drive the SERVED click handler against the SERVED showQR and read
// the query parameter the way the service does, so the assertion is about the
// bytes the QR will actually carry.
// ---------------------------------------------------------------------------

const SHORT_URL = "https://shorter.juancode.dev/X4tonhH";

describe("the QR image encodes the short URL, not its encoded form", () => {
  /**
   * Drives the REAL click handler against the REAL showQR and reports the bytes
   * the QR image will carry.
   *
   * Both halves matter. The double encode was split across them — the click
   * handler encoded, and showQR encoded again — so testing showQR in isolation
   * passes against the shipped bug. Only the whole path, handler included,
   * shows the payload the QR service actually receives.
   */
  async function clickQr(rawUrl: string) {
    const script = await clientScript();

    const written: Record<string, any> = {
      "qr-img": { src: "" },
      "qr-url": { textContent: "" },
      "qr-modal": { classList: { remove: () => {} } },
    };
    const document = { getElementById: (id: string) => written[id] };

    // The other actions are never reached, so their helpers are deliberately
    // absent — an undefined identifier only throws on the branch that uses it.
    // eslint-disable-next-line no-new-func
    const onLinksTableClick = new Function(
      "document",
      `${extractFunction(script, "showQR")}\n${extractFunction(script, "onLinksTableClick")}\nreturn onLinksTableClick;`,
    )(document);

    const el = { dataset: { action: "qr", url: rawUrl } };
    onLinksTableClick({
      target: { closest: (sel: string) => (sel === "[data-action]" ? el : null) },
      // Forwarded verbatim to showQR, which stops the row's own click handler.
      stopPropagation: () => {},
    });

    return {
      // Exactly what the QR service receives as `data`, after its own decode.
      qrPayload: new URL(written["qr-img"].src).searchParams.get("data"),
      caption: written["qr-url"].textContent,
      rawSrc: written["qr-img"].src,
    };
  }

  it("round-trips a plain short URL through the query parameter", async () => {
    const { qrPayload } = await clickQr(SHORT_URL);
    expect(qrPayload).toBe(SHORT_URL);
  });

  it("shows the same bytes the QR encodes", async () => {
    // The print-sheet handoff reads #qr-url. If the caption and the payload can
    // disagree, the owner copies one string and prints a QR carrying another.
    const { qrPayload, caption } = await clickQr(SHORT_URL);
    expect(caption).toBe(qrPayload);
  });

  it("still encodes reserved characters so the query parameter survives", async () => {
    // One layer of encoding is not the same as none: a bare `&` or `#` in the
    // payload would terminate the parameter or start a fragment.
    const awkward = "https://shorter.juancode.dev/a?b=1&c=2#frag";
    const { qrPayload, rawSrc } = await clickQr(awkward);

    expect(qrPayload).toBe(awkward);
    expect(rawSrc).toContain("%26");
  });

  it("does not double-encode at the click handler", async () => {
    // The regression, stated at the source: the payload is already encoded by
    // the time showQR encodes it a second time.
    const script = await clientScript();
    expect(script).not.toMatch(/showQR\(\s*encodeURIComponent/);
  });

  it("never decodes in showQR, which would throw on a literal %", async () => {
    const src = extractFunction(await clientScript(), "showQR");
    expect(src).not.toContain("decodeURIComponent");
  });
});

// ---------------------------------------------------------------------------
// Creating card stock from the form (T4 UI)
//
// The API can create a destination-less link. If the form still says
// `required`, that capability is unreachable by the person who needs it, and
// the API is right for no one. These tests pin the two halves of the form —
// that the browser does not block an empty destination, and that the handler
// omits the key rather than sending a blank one.
// ---------------------------------------------------------------------------

describe("the create form can manufacture card stock", () => {
  it("does not mark the destination as required", async () => {
    const html = await serve();

    // `required` would block the exact flow this feature exists for, in the
    // one place the owner actually types.
    expect(html).not.toMatch(/<input[^>]*id="url"[^>]*\brequired\b/);
  });

  it("keeps the destination field, labelled and first", async () => {
    const html = await serve();

    // Optional must not mean hidden or deprioritised — creating a normal link
    // is the common case and must stay the obvious one.
    expect(html).toContain('<label for="url">Destination URL</label>');
    expect(html).toContain('id="url"');
  });

  it("says what an empty destination produces", async () => {
    const html = await serve();

    // A blank submit that silently creates a card pointing nowhere is the
    // accident this helps avoid, so the consequence is stated on the form.
    expect(html).toContain("field-help");
    expect(html).toContain("later");
  });

  it("omits original_url entirely when the field is blank", async () => {
    const script = await clientScript();

    // Sending "" would rely on a server-side coercion the reader has to go and
    // find. Omitting states the intent at the boundary.
    expect(script).toContain("...(urlValue ? { original_url: urlValue } : {})");
  });

  it("trims the destination before sending it", async () => {
    const script = await clientScript();

    expect(script).toContain('getElementById("url").value.trim()');
  });

  it("distinguishes a card from a link in the confirmation", async () => {
    const script = await clientScript();

    // "Link created!" for a link with no destination is a small lie the owner
    // discovers later, when a customer scans the sticker.
    expect(script).toContain("Card created!");
    expect(script).toContain("data.original_url");
  });

  it("still clears the destination field after creating", async () => {
    const script = await clientScript();

    expect(script).toContain('document.getElementById("url").value = ""');
  });
});

// ---------------------------------------------------------------------------
// Bulk card creation
//
// An owner making a hundred stickers does not want a hundred form submissions.
// This creates them in one call with no destination and hands back a print sheet
// the designer can use directly.
//
// The generated ids live in module scope rather than in a data-* attribute,
// because the download button needs them and a second copy in the DOM could
// drift out of sync with the list the handler actually holds.
// ---------------------------------------------------------------------------

describe("the dashboard can manufacture cards in bulk", () => {
  it("offers a bulk entry point", async () => {
    const html = await serve();
    expect(html).toContain('id="open-bulk"');
    expect(html).toContain('id="bulk-modal"');
  });

  it("asks for a count and nothing else", async () => {
    const html = await serve();

    // Every other field on a link is per-card by nature. Inventing a bulk
    // meaning for each would be inventing vocabulary the product does not have.
    const modal = html.slice(html.indexOf('id="bulk-modal"'));
    const card = modal.slice(0, modal.indexOf("</div>"));
    expect(card).toContain('id="bulk-count"');
    expect(card).not.toContain('id="url"');
  });

  it("caps the count at the server's own limit", async () => {
    const html = await serve();
    // The server is what makes it safe; this stops a 900-card request spending
    // ten seconds before it is refused.
    expect(html).toContain('max="200"');
  });

  it("says what an unconfigured card does when scanned", async () => {
    const html = await serve();
    // The owner has to know the QR is not broken — it is waiting.
    expect(html).toContain("not configured");
  });

  it("creates the cards WITHOUT a destination", async () => {
    const script = await clientScript();

    // The item literal itself is the claim: a card is `is_gated` and nothing
    // else. Asserting on the whole script for "no original_url" would also
    // catch the single-create form above, which legitimately has one.
    // The item literal IS the claim: a card is gated, and it carries a
    // destination only if the owner typed a label. `...(label ? ...)` is what
    // makes "no destination" the default rather than a special case.
    expect(script).toContain("Array.from({ length: count }, () => ({");
    expect(script).toContain("is_gated: gated");
    // Scoped to the BULK BLOCK, not the whole script.
    //
    // The dashboard has two creation paths and only one of them must omit the
    // destination. The single-create form legitimately sets `original_url` — it
    // is how an owner shortens a URL they already have. Asserting on the whole
    // script conflates the two and is wrong, not merely imprecise.
    const start = script.indexOf(">>> BULK BLOCK");
    const end = script.indexOf("<<< BULK BLOCK", start);
    expect(codeOnly(script.slice(start, end))).not.toContain("original_url:");
  });

  it("lets the owner choose the review screen for the batch, OFF by default", async () => {
    const html = await serve();
    const script = await clientScript();

    // The owner decides now (odd/tasks/review-screen-refresh.md, S1). Unchecked
    // means the card goes straight to Google; the help text says that such
    // cards do not feed the satisfaction panel, which is the trade being made.
    const box = html.match(/<input[^>]*id="bulk-gated"[^>]*>/)?.[0] ?? "";
    expect(box).toContain('type="checkbox"');
    expect(box).not.toContain("checked");
    expect(script).toContain('document.getElementById("bulk-gated").checked');
  });

  it("posts to the batch endpoint that already exists", async () => {
    const script = await clientScript();
    expect(script).toContain('"/api/links/batch"');
  });

  it("reports a PARTIAL batch rather than calling it a success", async () => {
    const script = await clientScript();

    // Nine of ten cards is a shortfall the owner discovers at the printer.
    expect(script).toContain("failed — try those again");
    expect(script).toMatch(/created\.length/);
  });

  it("keeps only the ids that were actually created", async () => {
    const script = await clientScript();

    // A failed item has no link to export, so its id must not enter the sheet.
    expect(script).toContain('filter((r) => r.status === 201)');
  });

  it("downloads the sheet as a ZIP", async () => {
    const script = await clientScript();
    expect(script).toContain('"/api/links/qr-sheet.zip"');
    expect(script).toContain('a.download = "cards.zip"');
  });

  it("fetches the sheet as a blob rather than navigating to it", async () => {
    const script = await clientScript();

    // The claim is "not a navigation", and it holds for a reason that is now
    // structural rather than incidental: the request goes through __api, whose
    // signature is (method, path, body) — it cannot become a navigation, and it
    // returns the response so a blob can be read off it.
    expect(script).toContain('window.__api("POST", "/api/links/qr-sheet.zip", {');
    expect(script).toContain("URL.createObjectURL");
    expect(script).toContain("await res.blob()");
  });

  it("revokes the object URL, so the ZIP is not pinned in memory", async () => {
    const script = await clientScript();
    expect(script).toContain("URL.revokeObjectURL");
  });

  it("surfaces the server's own refusal instead of a generic failure", async () => {
    const script = await clientScript();

    // The server refuses a batch containing an unconfigured card and says so.
    // That sentence IS the answer.
    expect(script).toContain("body.error");
  });

  it("downloads through the dashboard's OWN api helper, not a hand-rolled fetch", async () => {
    const script = await clientScript();

    // THE REGRESSION THAT MATTERS.
    //
    // This handler originally did its own `fetch` with its own headers, reading
    // the token from `localStorage.getItem("access_token")`. The dashboard keeps
    // it in `window.__token`. So the create succeeded — it goes through __api —
    // and the download 401'd with `Bearer null`, leaving the modal claiming ten
    // cards existed and the sheet unreachable.
    //
    // Reusing __api is the fix: one auth contract, one place to change it, and
    // the 401-to-login and 409-tenant-picker behaviour comes along for free
    // instead of being reimplemented slightly wrong.
    expect(script).toContain('window.__api("POST", "/api/links/qr-sheet.zip"');
  });

  it("never rebuilds auth headers inside the bulk block", async () => {
    const script = await clientScript();
    const start = script.indexOf(">>> BULK BLOCK");
    const end = script.indexOf("<<< BULK BLOCK", start);
    const wired = script.slice(start, end);

    // A duplicated auth contract is a contract that will drift. The token lives
    // in one place and this block does not get a second opinion on where.
    expect(wired).not.toMatch(/Authorization:/);
    expect(wired).not.toMatch(/X-Tenant-Slug/);
  });

  it("inherits the full auth contract instead of approximating it", async () => {
    // Asserted against the WHOLE served page, not clientScript().
    //
    // The dashboard serves __api and the bulk client as two separate <script>
    // blocks, so clientScript() — which returns the one holding the client —
    // cannot see the helper at all. Scoping this assertion to it produced a
    // failure that looked like missing auth but was really the wrong slice.
    const html = await serve();

    // The download carries whatever __api carries — JWT, tenant, and the 409
    // picker — by going through it at all. This asserts the helper still does
    // its own job, so the download inherits a working contract rather than a
    // broken one.
    expect(html).toContain("Bearer " + '" + window.__token');
    expect(html).toContain('headers["X-Tenant-Slug"] = q');
  });

  it("refuses to download before anything was created", async () => {
    const script = await clientScript();
    expect(script).toContain("Create the cards first.");
  });

  it("validates the count before spending a request on it", async () => {
    const script = await clientScript();

    // A button that does nothing for ten seconds because the count was 0
    // teaches the owner the button is broken.
    expect(script).toMatch(/count < 1 \|\| count > 200/);
  });

  it("adds no inline handler and no new data-action", async () => {
    const script = await clientScript();

    // The delegated switch handles record actions and a test pins its exact
    // membership. Bulk acts on NO record, so it must not join that switch — it
    // is a static button with a static listener, like the create form.
    //
    // Scoped to the bulk BLOCK, delimited by the two function names that bracket
    // it in the source. Slicing to the end of the script would sweep in the
    // delegated switch below, which legitimately contains data-action and would
    // make the assertion meaningless.
    // Delimited by markers the source plants, not by guessing where a
    // function happens to end — a slice bounded by a function name breaks the
    // moment the block is reordered.
    const start = script.indexOf(">>> BULK BLOCK");
    const end = script.indexOf("<<< BULK BLOCK", start);
    const wired = script.slice(start, end);
    expect(wired.length).toBeGreaterThan(0);
    // Matched on the ATTRIBUTE, not the substring: an earlier version asserted
    // on "data-action" and this very comment contained the word, so the test
    // detected itself and failed for a reason that had nothing to do with the
    // code under test.
    expect(wired).not.toMatch(/data-action=/);

    // And the switch carries exactly ten record actions, no more. Pinned
    // because this is the list that decides what a row may do: an action added
    // here reaches the handler with a row's own id, so an unlisted one silently
    // does nothing while looking wired.
    //
    // load-destination joined the six on purpose — it IS a record action, and it
    // is the second half of the flow this PR completes. toggle-gate joined for
    // the review-screen checkbox (odd/tasks/review-screen-refresh.md, S1).
    // load-destination became save-destination (any link's URL is editable
    // now) and save-branch joined (odd/tasks/business-branches.md, S4). edit
    // joined because the panel was only reachable through the clicks count,
    // and the operator could not find it.
    const actions = [...script.matchAll(/case "([a-z-]+)":/g)].map((m) => m[1]);
    expect(new Set(actions)).toEqual(
      new Set([
        "copy",
        "qr",
        "metrics",
        "edit",
        "save-client-ref",
        "save-destination",
        "save-branch",
        "toggle",
        "toggle-gate",
        "delete",
      ]),
    );
  });
});

// ---------------------------------------------------------------------------
// Loading a destination onto a card
//
// A card is manufactured before anyone knows where it points. The API has always
// accepted the destination and invalidated the redirect cache; what was missing
// was the door — so "load them before exporting" was an instruction with nowhere
// to go, and the owner's only way to fill ten cards was the API.
// ---------------------------------------------------------------------------
describe("the dashboard can edit any link's destination", () => {
  // It used to offer "Load destination..." only on card stock, through a
  // prompt. A configured link could not be corrected at all from the
  // dashboard (odd/tasks/business-branches.md, S4).
  it("shows the current destination in an editable field on every row", async () => {
    const row = await renderRow({ original_url: "https://g.page/r/abc/review" });
    const input = row.match(/<input[^>]*id="dest-link-uuid"[^>]*>/)?.[0] ?? "";
    expect(input).toContain('value="https://g.page/r/abc/review"');
    expect(row).toMatch(/data-action="save-destination"[^>]*data-id="link-uuid"/);
  });

  it("offers the same field on card stock, empty", async () => {
    const row = await renderRow({ original_url: null });
    const input = row.match(/<input[^>]*id="dest-link-uuid"[^>]*>/)?.[0] ?? "";
    expect(input).toContain('value=""');
    expect(row).toContain('data-action="save-destination"');
  });

  it("says what an unconfigured card does when scanned, and that no reprint is needed", async () => {
    const row = await renderRow({ original_url: null });
    // The owner has to know the QR is not broken — it is waiting.
    expect(row).toContain("not configured");
    expect(row).toContain("does not need reprinting");
    expect(await renderRow()).not.toContain("not configured");
  });

  it("escapes the destination it puts in the field", async () => {
    const row = await renderRow({ original_url: XSS_ATTR });
    expect(row).not.toContain(XSS_ATTR);
    expect(row).toContain(ESCAPED_ATTR);
  });

  it("PATCHes the existing link, and an emptied field clears it back to card stock", async () => {
    const fn = extractFunction(await clientScript(), "saveDestination");
    // The card exists and is already printed: never create a second one.
    expect(fn).toContain('window.__api("PATCH", "/api/links/" + id');
    expect(fn).toContain('original_url: value === "" ? null : value');
  });

  it("does NOT re-validate the URL in the browser", async () => {
    // The server owns URL validation for create and update alike.
    const fn = codeOnly(extractFunction(await clientScript(), "saveDestination"));
    expect(fn).not.toMatch(/https?:\/\//);
  });

  it("refreshes the table after saving", async () => {
    expect(extractFunction(await clientScript(), "saveDestination")).toContain("loadLinks()");
  });
});

describe("links table shows how each link opens and where it belongs", () => {
  it("labels a gated link as opening the review screen", async () => {
    const row = await renderRow({ is_gated: true });
    expect(row).toContain("Review screen");
  });

  it("labels an ungated link as going straight to its destination", async () => {
    const row = await renderRow({ is_gated: false });
    expect(row).toContain("Direct");
    expect(row).not.toContain("Review screen</span>");
  });

  it("shows the business and branch of a link", async () => {
    const row = await renderRow({ business_name: "Café Central", location_name: "Providencia" });
    expect(row).toContain("Café Central");
    expect(row).toContain("Providencia");
  });

  it("escapes the business and branch names", async () => {
    const row = await renderRow({ business_name: XSS_URL, location_name: XSS_URL });
    expect(row).not.toContain("<img");
  });

  it("says 'Unassigned' for a link with no branch", async () => {
    const row = await renderRow({ business_name: null, location_name: null });
    expect(row).toContain("Unassigned");
  });

  it("offers a branch picker in the row panel, filled after render", async () => {
    const row = await renderRow({ location_id: "loc-1" });
    const select = row.match(/<select[^>]*id="branch-link-uuid"[^>]*>/)?.[0] ?? "";
    expect(select).toContain('data-current="loc-1"');
    expect(row).toMatch(/data-action="save-branch"[^>]*data-id="link-uuid"/);
    // The row template stays a pure function of the link; the options come
    // from the branches list once the table is in the DOM.
    expect(await clientScript()).toContain("fillBranchSelects()");
  });

  it("never shows an assigned link as Unassigned when the branches list is missing", async () => {
    // One Save on a picker that wrongly reads "Unassigned" would detach the
    // link. Runs the shipped function against a minimal DOM stand-in.
    const script = await clientScript();
    const fn = extractFunction(script, "fillBranchSelects") + "\n" + extractFunction(script, "pickableBranches");
    const options: { value: string; selected: boolean }[] = [];
    const select = {
      dataset: { current: "loc-1" },
      set textContent(_v: string) { options.length = 0; },
      add: (o: { value: string; selected: boolean }) => options.push(o),
    };
    const run = new Function(
      "window", "document", "Option",
      `${fn}\nfillBranchSelects();`,
    );
    run(
      { __branches: [] },
      { querySelectorAll: () => [select] },
      function (this: any, _l: string, value: string, _d?: boolean, selected = false) {
        return { value, selected };
      },
    );
    expect(options.find((o) => o.selected)?.value).toBe("loc-1");
  });

  it("loads the branches at boot, beside the links", async () => {
    const html = await serve();
    expect(html).toContain('if (typeof loadBranches === "function") loadBranches();');
    expect(extractFunction(await clientScript(), "loadBranches")).toContain('"/api/locations"');
  });

  it("assigns the branch through PATCH, null for none", async () => {
    const fn = extractFunction(await clientScript(), "saveBranch");
    expect(fn).toContain('window.__api("PATCH", "/api/links/" + id');
    expect(fn).toContain('location_id: value === "" ? null : value');
    expect(fn).toContain("loadLinks()");
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
    const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    const client = blocks.find((b) => b.includes("links-body"));
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
    const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    const client = blocks.find((b) => b.includes("links-body"))!;

    expect(client).not.toMatch(/window\.prompt\("[^"]*\n/);
  });
});

describe("a bulk batch can carry one label", () => {
  it("asks for a label beside the count", async () => {
    const html = await serve();

    expect(html).toContain('id="bulk-label"');
    expect(html).toContain("Label for this batch");
  });

  it("says the label reaches the card AND the CSV", async () => {
    const html = await serve();

    // The CSV is what the designer reads while laying out the sheet. A label
    // that reaches only the card would still leave ten identical stickers and
    // a blank column.
    expect(html).toMatch(/CSV/);
    expect(html).toMatch(/designer/i);
  });

  it("applies ONE label to every card in the batch", async () => {
    const script = await clientScript();

    // Ten stickers for the main room is one decision, not ten. Asking for a
    // label per card would make a batch a form again.
    expect(script).toContain("client_ref: label");
    expect(script).toContain("Array.from({ length: count }");
  });

  it("treats an empty label as no label at all", async () => {
    const script = await clientScript();

    // A blank input must not produce ten cards carrying a blank identifier —
    // that is a value that looks like data and is not.
    expect(script).toContain("...(label ? { client_ref: label } : {})");
    expect(script).toContain(".value.trim()");
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
    expect(html).toMatch(/satisfaction panel/i);
  });

  it("puts the panel before the satisfaction panel it refers to", async () => {
    const html = await serve();

    // The text tells the owner where their comments still arrive. That sentence
    // only makes sense if the panel it names is on the same page.
    const card = html.indexOf('id="feedback-email-card"');
    const gate = html.indexOf('id="gate-card"');
    expect(card).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(-1);
    expect(card).toBeLessThan(gate);
  });

  it("PUTs to the tenant-scoped endpoint", async () => {
    const script = await clientScript();
    expect(script).toContain('window.__api("PUT", "/api/tenant/feedback-email"');
  });

  it("loads the stored address once at boot, not on every table render", async () => {
    const script = await clientScript();

    expect(script).toContain('window.__api("GET", "/api/tenant/feedback-email"');

    // loadLinks runs on every toggle, delete and create. Re-reading a
    // tenant-level setting on each one is a request per keystroke of somebody
    // else's workflow.
    //
    // Asserted against the whole served page because the boot call lives in the
    // OTHER inline <script> — the auth bootstrap, not the links client. Reading
    // it from clientScript() looks for a string that is not there and returns
    // -1, which is how this first failed.
    const html = await serve();
    const at = html.indexOf("loadFeedbackEmail();");
    const linksAt = html.indexOf("loadLinks();", at);
    expect(at).toBeGreaterThan(-1);
    expect(linksAt).toBeGreaterThan(at);
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
// once at boot outside loadLinks' all-or-nothing fetch, and that the export
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

  it("loads the inbox once at boot, not inside loadLinks", async () => {
    const script = await clientScript();
    expect(script).toContain('window.__api("GET", "/api/review-gate/feedback" + feedbackQuery())');
    expect(extractFunction(script, "loadLinks")).not.toContain("/api/review-gate/feedback");

    const html = await serve();
    const at = html.indexOf("loadFeedbackInbox();");
    const linksAt = html.indexOf("loadLinks();", at);
    expect(at).toBeGreaterThan(-1);
    expect(linksAt).toBeGreaterThan(at);
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

describe("review screen checkbox", () => {
  it("is on the create form, unchecked by default", async () => {
    const html = await serve();
    const box = html.match(/<input[^>]*id="gated"[^>]*>/)?.[0] ?? "";
    expect(box).toContain('type="checkbox"');
    expect(box).not.toContain("checked");
  });

  it("sends the choice with the create request", async () => {
    const script = await clientScript();
    expect(script).toContain('is_gated: document.getElementById("gated").checked');
  });

  it("shows a checked box on a row whose link shows the review screen", async () => {
    const row = await renderRow({ is_gated: true });
    const box = row.match(/<input[^>]*data-action="toggle-gate"[^>]*>/)?.[0] ?? "";
    expect(box).toContain('type="checkbox"');
    expect(box).toContain('data-id="link-uuid"');
    expect(box).toMatch(/\schecked/);
  });

  it("shows an unchecked box on a row that goes straight to the destination", async () => {
    const row = await renderRow({ is_gated: false });
    const box = row.match(/<input[^>]*data-action="toggle-gate"[^>]*>/)?.[0] ?? "";
    expect(box).toContain('type="checkbox"');
    expect(box).not.toMatch(/\schecked/);
  });

  it("updates the link through PATCH when the box changes", async () => {
    const script = await clientScript();
    expect(script).toContain('case "toggle-gate":');
    const fn = extractFunction(script, "setGated");
    expect(fn).toContain('window.__api("PATCH", "/api/links/" + id, { is_gated: gated })');
  });
});

// ---------------------------------------------------------------------------
// Full-width layout (odd/tasks/review-screen-refresh.md, S5)
//
// The page used to be a single 720px column centred in the window. It now uses
// the width: a main column for what the owner reads, a side column for what
// they configure, stacked on a phone.
// ---------------------------------------------------------------------------

describe("full-width layout", () => {
  /** The markup between an element's opening tag and the next column marker. */
  function column(html: string, cls: string): string {
    const start = html.indexOf(`<div class="${cls}">`);
    expect(start, `${cls} is missing`).toBeGreaterThan(-1);
    const next = html.indexOf('<div class="col-', start + 1);
    return html.slice(start, next > -1 ? next : html.indexOf("</main>", start));
  }

  it("no longer caps the page at a 720px column", async () => {
    const html = await serve();
    expect(html).not.toContain("max-width: 720px");
    expect(html).toMatch(/\.container\s*\{[^}]*max-width:\s*1440px/);
  });

  it("splits into two columns on a wide screen", async () => {
    const html = await serve();
    expect(html).toMatch(/@media \(min-width: 1024px\)\s*\{\s*\.layout\s*\{[^}]*grid-template-columns/);
  });

  it("puts what the owner configures in the side column", async () => {
    const side = column(await serve(), "col-side");
    expect(side).toContain('id="create-form"');
    expect(side).toContain('id="feedback-email-card"');
  });

  it("puts what the owner reads in the main column, satisfaction first", async () => {
    const main = column(await serve(), "col-main");
    const at = (needle: string) => main.indexOf(needle);
    expect(at('id="gate-card"')).toBeGreaterThan(-1);
    expect(at('id="links-table"')).toBeGreaterThan(at('id="gate-card"'));
    expect(at('id="feedback-card"')).toBeGreaterThan(at('id="links-table"'));
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

  it("lives in the side column, with a field to add a business", async () => {
    const html = await serve();
    const side = html.slice(html.indexOf('<div class="col-side">'), html.indexOf('<div class="col-main">'));
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
    expect(extractFunction(script, "refreshOwnership")).toContain("loadLinks()");
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
// An explicit Edit button
//
// The editing panel (destination, branch, review screen) only opened from the
// clicks count. Reported from production: "aun no veo el boton de editar".
// ---------------------------------------------------------------------------

describe("each row has an Edit button", () => {
  it("renders a visible Edit button beside Del, carrying the row's id", async () => {
    const row = await renderRow();
    const actions = row.slice(row.indexOf('class="row-actions"'));
    const edit = actions.match(/<button[^>]*data-action="edit"[^>]*>([^<]*)<\/button>/);
    expect(edit?.[1]).toBe("Edit");
    expect(edit?.[0]).toContain('data-id="link-uuid"');
    expect(edit?.[0]).toContain('data-code="abc1234"');
    expect(actions.indexOf('data-action="edit"')).toBeLessThan(actions.indexOf('data-action="delete"'));
  });

  it("opens the same panel as the clicks count and focuses the destination", async () => {
    const script = await clientScript();
    const sw = extractFunction(script, "onLinksTableClick");
    const edit = sw.slice(sw.indexOf('case "edit":'), sw.indexOf("break;", sw.indexOf('case "edit":')));
    expect(edit).toContain("openEditor(el.dataset.id, el.dataset.code, e)");
    const fn = extractFunction(script, "openEditor");
    expect(fn).toContain("showMetrics(id, code, e)");
    expect(fn).toContain('document.getElementById("dest-" + id)');
    expect(fn).toContain(".focus()");
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

  it("keeps inactive branches and businesses out of a link's branch picker, except its current one", async () => {
    const script = await clientScript();
    const fn = extractFunction(script, "fillBranchSelects") + "\n" + extractFunction(script, "pickableBranches");
    const options: { label: string; value: string; selected: boolean }[] = [];
    const select = {
      dataset: { current: "loc-old" },
      set textContent(_v: string) { options.length = 0; },
      add: (o: { label: string; value: string; selected: boolean }) => options.push(o),
    };
    new Function("window", "document", "Option", `${fn}\nfillBranchSelects();`)(
      {
        __businesses: businesses,
        __branches: [
          { id: "loc-1", name: "Providencia", business_id: "biz-1", business_name: "Café Central", is_active: true },
          { id: "loc-old", name: "Vieja", business_id: "biz-1", business_name: "Café Central", is_active: false },
          { id: "loc-3", name: "Centro", business_id: "biz-3", business_name: "Cerrado", is_active: true },
        ],
      },
      { querySelectorAll: () => [select] },
      function (label: string, value: string, _d?: boolean, selected = false) {
        return { label, value, selected };
      },
    );
    expect(options.map((o) => o.value)).toEqual(["", "loc-1", "loc-old"]);
    // The link's own branch stays, named, so one Save does not detach it.
    expect(options.find((o) => o.selected)).toEqual({ label: "Café Central — Vieja (inactive)", value: "loc-old", selected: true });
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
